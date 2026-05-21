const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Supabase (database + storage)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const storageBucket = process.env.SUPABASE_STORAGE_BUCKET || 'reports';

// Email transporter (Nodemailer)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ---------- RISK FACTOR CLASSIFICATION (FertiSTAT + TB) ----------
function classifyRiskFactor(factor, value) {
  switch (factor) {
    case 'age':
      if (value < 30) return { level: 'green', label: 'Under 30 – low risk' };
      if (value <= 34) return { level: 'amber', label: '30–34 – slight fertility decline' };
      if (value <= 37) return { level: 'amber', label: '35–37 – moderate decline' };
      if (value <= 40) return { level: 'red', label: '38–40 – significant decline' };
      return { level: 'red', label: 'Over 40 – marked decline' };
    case 'bmi':
      if (value >= 18.5 && value < 25) return { level: 'green', label: 'Normal weight' };
      if ((value >= 25 && value < 30) || (value >= 17 && value < 18.5)) return { level: 'amber', label: 'Overweight or underweight – may affect ovulation' };
      return { level: 'red', label: 'Obese or severely underweight – strongly affects fertility' };
    case 'prevBirth':
      return value === 'yes' ? { level: 'green', label: 'Proven fertility' } : { level: 'amber', label: 'No previous pregnancy – possible undiagnosed factors' };
    case 'cycleReg':
      return value === 'regular' ? { level: 'green', label: 'Regular cycles' } : { level: 'red', label: 'Irregular cycles – likely ovulatory problem' };
    case 'pcos':
      return value === 'yes' ? { level: 'red', label: 'PCOS diagnosis' } : { level: 'green', label: 'No PCOS' };
    case 'endo':
      return value === 'yes' ? { level: 'red', label: 'Endometriosis diagnosis' } : { level: 'green', label: 'No endometriosis' };
    case 'thyroid':
      if (value === 'no') return { level: 'green', label: 'No thyroid condition' };
      if (value === 'treated') return { level: 'amber', label: 'Thyroid condition (treated)' };
      return { level: 'red', label: 'Thyroid condition (untreated)' };
    case 'diabetes':
      return value === 'yes' ? { level: 'red', label: 'Diabetes' } : { level: 'green', label: 'No diabetes' };
    case 'smoking':
      return value === 'yes' ? { level: 'red', label: 'Current smoker' } : { level: 'green', label: 'Non-smoker' };
    case 'alcohol':
      return value === 'yes' ? { level: 'red', label: 'Heavy alcohol intake (>7 drinks/week)' } : { level: 'green', label: 'Low/no alcohol' };
    case 'tryDuration':
      return value === 'over12' ? { level: 'red', label: 'Trying to conceive ≥12 months' } : { level: 'amber', label: 'Trying <12 months' };
    case 'stiHistory':
      return value === 'yes' ? { level: 'red', label: 'History of STI (chlamydia/gonorrhoea) – possible tubal damage' } : { level: 'green', label: 'No STI history' };
    case 'pelvicSurgery':
      return value === 'yes' ? { level: 'red', label: 'Previous pelvic surgery' } : { level: 'green', label: 'No pelvic surgery' };
    case 'familyEarlyMenopause':
      return value === 'yes' ? { level: 'red', label: 'Family history of early menopause' } : { level: 'green', label: 'No family history' };
    case 'recreationalDrugs':
      return value === 'yes' ? { level: 'red', label: 'Recreational drug use' } : { level: 'green', label: 'No recreational drugs' };
    case 'caffeine':
      return value === 'high' ? { level: 'amber', label: 'High caffeine (>200 mg/day)' } : { level: 'green', label: 'Low/moderate caffeine' };
    case 'cancerTreatment':
      return value === 'yes' ? { level: 'red', label: 'History of cancer treatment (chemo/radiation)' } : { level: 'green', label: 'No cancer treatment' };
    case 'tbPersonal':
      if (value === 'yes') return { level: 'red', label: 'History of tuberculosis (possible genital TB)' };
      if (value === 'unsure') return { level: 'amber', label: 'Unsure about TB history' };
      return { level: 'green', label: 'No TB history' };
    case 'tbContact':
      return value === 'yes' ? { level: 'amber', label: 'Close contact with a TB patient' } : { level: 'green', label: 'No TB contact' };
    default:
      return { level: 'green', label: '' };
  }
}

function determineRiskCategory(factors) {
  let redCount = 0, amberCount = 0;
  for (const [factor, value] of Object.entries(factors)) {
    const { level } = classifyRiskFactor(factor, value);
    if (level === 'red') redCount++;
    else if (level === 'amber') amberCount++;
  }
  if (redCount >= 2 || (redCount === 1 && amberCount >= 3)) return 'high';
  if (redCount === 1 || amberCount >= 3) return 'medium';
  return 'low';
}

function assessOvarianReserve(amh, fsh, afc) {
  let reserve = 'adequate', cluster = 'A';
  if ((amh !== null && amh < 1.0 && fsh !== null && fsh > 10) || (amh !== null && amh < 0.5) || (afc !== null && afc <= 5)) {
    reserve = 'severely reduced'; cluster = 'D';
  } else if ((amh !== null && amh >= 0.5 && amh < 1.0 && (fsh === null || fsh <= 10)) || (afc !== null && afc >= 5 && afc <= 7)) {
    reserve = 'moderately reduced'; cluster = 'C';
  } else if ((amh !== null && amh >= 1.0 && amh < 2.0 && (fsh === null || fsh < 8)) || (afc !== null && afc >= 7 && afc <= 10)) {
    reserve = 'mildly reduced'; cluster = 'B';
  }
  return { reserve, cluster };
}

function buildReport(data) {
  const factors = {
    age: data.age,
    bmi: data.bmi,
    prevBirth: data.prevBirth,
    cycleReg: data.cycleReg,
    pcos: data.pcos,
    endo: data.endo,
    thyroid: data.thyroid,
    diabetes: data.diabetes,
    smoking: data.smoking,
    alcohol: data.alcohol,
    tryDuration: data.tryDuration,
    stiHistory: data.stiHistory,
    pelvicSurgery: data.pelvicSurgery,
    familyEarlyMenopause: data.familyEarlyMenopause,
    recreationalDrugs: data.recreationalDrugs,
    caffeine: data.caffeine,
    cancerTreatment: data.cancerTreatment,
    tbPersonal: data.tbPersonal,
    tbContact: data.tbContact
  };
  const category = determineRiskCategory(factors);
  let report = `📊 *Fertility Risk Report for ${data.name}*\n\n`;
  report += `Overall risk: *${category.toUpperCase()}*\n\n`;
  report += `Factors identified:\n`;
  let hasRisks = false;
  for (const [factor, value] of Object.entries(factors)) {
    const { level, label } = classifyRiskFactor(factor, value);
    if (level !== 'green') {
      hasRisks = true;
      const emoji = level === 'red' ? '🔴' : '🟠';
      report += `${emoji} ${label}\n`;
    }
  }
  if (!hasRisks) report += `✅ No significant risk factors identified.\n`;
  if (category === 'high') report += `\n➡️ Prompt specialist consultation advised.`;
  else if (category === 'medium') report += `\n➡️ Consider lifestyle changes and consult if not pregnant within 6–12 months.`;
  else report += `\n➡️ Fertility potential appears favourable.`;
  if (data.amhValue || data.fsh || data.afc) {
    const amh = data.amhValue ? parseFloat(data.amhValue) : null;
    const fsh = data.fsh ? parseFloat(data.fsh) : null;
    const afc = data.afc ? parseInt(data.afc) : null;
    const { reserve, cluster } = assessOvarianReserve(amh, fsh, afc);
    report += `\n\n🔬 Ovarian Reserve (AAFA): ${reserve} (Cluster ${cluster})`;
  }
  report += `\n\n⚠️ This is not a diagnosis.`;
  return report;
}

// ---------- PDF GENERATION ----------
async function generateReportPDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const buffers = [];
    doc.on('data', chunk => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);
    doc.fontSize(20).text('Fertility Risk Report', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Name: ${data.name}    Age: ${data.age}    Gender: Female`);
    doc.moveDown();
    const category = determineRiskCategory(data);
    doc.text(`Overall Risk: ${category.toUpperCase()}`, { underline: true });
    doc.moveDown();
    doc.text('Identified Risk Factors:');
    const factors = {
      age: data.age, bmi: data.bmi, prevBirth: data.prevBirth, cycleReg: data.cycleReg,
      pcos: data.pcos, endo: data.endo, thyroid: data.thyroid, diabetes: data.diabetes,
      smoking: data.smoking, alcohol: data.alcohol, tryDuration: data.tryDuration,
      stiHistory: data.stiHistory, pelvicSurgery: data.pelvicSurgery,
      familyEarlyMenopause: data.familyEarlyMenopause,
      recreationalDrugs: data.recreationalDrugs, caffeine: data.caffeine,
      cancerTreatment: data.cancerTreatment, tbPersonal: data.tbPersonal, tbContact: data.tbContact
    };
    for (const [factor, value] of Object.entries(factors)) {
      const { level, label } = classifyRiskFactor(factor, value);
      if (level !== 'green') doc.text(`• ${label}`, { indent: 20 });
    }
    if (data.amhValue || data.fsh || data.afc) {
      doc.moveDown();
      const amh = data.amhValue ? parseFloat(data.amhValue) : null;
      const fsh = data.fsh ? parseFloat(data.fsh) : null;
      const afc = data.afc ? parseInt(data.afc) : null;
      const { reserve, cluster } = assessOvarianReserve(amh, fsh, afc);
      doc.text(`Ovarian Reserve (AAFA): ${reserve} (Cluster ${cluster})`);
    }
    doc.moveDown();
    doc.text('This is not a medical diagnosis. Consult a fertility specialist.', { italic: true });
    doc.end();
  });
}

async function uploadPDF(pdfBuffer, filename) {
  const { error } = await supabase.storage
    .from(storageBucket)
    .upload(filename, pdfBuffer, { contentType: 'application/pdf', upsert: true });
  if (error) throw error;
  const { data: publicUrlData } = supabase.storage.from(storageBucket).getPublicUrl(filename);
  return publicUrlData.publicUrl;
}

async function sendEmail(to, subject, text, pdfBuffer) {
  const mailOptions = {
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
    attachments: [{ filename: 'Fertility_Report.pdf', content: pdfBuffer }],
  };
  return transporter.sendMail(mailOptions);
}

// ---------- SAVE LEAD ----------
async function saveLeadToSupabase(data) {
  const { error } = await supabase.from('leads').insert([{
    source: 'whatsapp',
    name: data.name,
    email: data.email || null,
    phone: data.phone,
    age: data.age, height: data.height, weight: data.weight, bmi: data.bmi,
    prev_birth: data.prevBirth, cycle_reg: data.cycleReg, pcos: data.pcos,
    endometriosis: data.endo, thyroid: data.thyroid, diabetes: data.diabetes,
    smoking: data.smoking, alcohol: data.alcohol, try_duration: data.tryDuration,
    sti_history: data.stiHistory, pelvic_surgery: data.pelvicSurgery,
    family_early_menopause: data.familyEarlyMenopause,
    recreational_drugs: data.recreationalDrugs, caffeine: data.caffeine,
    cancer_treatment: data.cancerTreatment,
    tb_personal: data.tbPersonal, tb_contact: data.tbContact,
    lab_amh: data.lab_amh || null, lab_amh_unit: data.lab_amh_unit || null,
    lab_fsh: data.lab_fsh || null, lab_afc: data.lab_afc || null,
    risk_category: data.risk_category,
    risk_report: data.risk_report,
    consent_marketing: data.consent_marketing || false,
    consent_research: false
  }]);
  if (error) console.error('Supabase insert error:', error);
  return !error;
}

// ---------- HELPER: Quick Reply Buttons ----------
function sendWithButtons(res, bodyText, buttons) {
  const twiml = new MessagingResponse();
  let optionsText = buttons.map((b, i) => `${i+1}. ${b.title}`).join('\n');
  twiml.message(`${bodyText}\n\n${optionsText}`);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
}

// ---------- WHATSAPP BOT ----------
const sessions = new Map();

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const from = req.body.From;  // e.g., "whatsapp:+14155238886"
  const incomingMsg = req.body.Body.trim();
  const lower = incomingMsg.toLowerCase();

  let session = sessions.get(from);
  if (!session) {
    session = { step: 'name', data: {}, name: '' };
    sessions.set(from, session);
  }

  if (lower === 'restart') {
    session.step = 'name'; session.data = {}; session.name = '';
    twiml.message('🌸 *Fertility Check‑In*\n\nWhat is your *name*?');
    return res.end(twiml.toString());
  }

  let reply = '';
  const name = session.name || '';

  switch (session.step) {
    case 'name':
      if (incomingMsg.length < 2) {
        reply = 'Please enter a valid name.';
      } else {
        session.name = incomingMsg;
        session.step = 'age';
        reply = `Thanks, ${session.name}! Let's begin. *What is your age?*`;
      }
      break;

    case 'age': {
      let age = parseInt(incomingMsg);
      if (isNaN(age) || age < 18 || age > 55) {
        reply = 'Please enter a valid age between 18 and 55.';
      } else {
        session.data.age = age;
        session.step = 'height';
        reply = `Okay ${session.name}, *what is your height in cm?* (e.g., 165)`;
      }
      break;
    }

    case 'height': {
      let h = parseFloat(incomingMsg);
      if (isNaN(h) || h < 130 || h > 220) {
        reply = 'Please enter a realistic height in cm (130–220).';
      } else {
        session.data.height = h;
        session.step = 'weight';
        reply = `And *what is your weight in kg?* (e.g., 68)`;
      }
      break;
    }

    case 'weight': {
      let w = parseFloat(incomingMsg);
      if (isNaN(w) || w < 30 || w > 250) {
        reply = 'Please enter a valid weight in kg (30–250).';
      } else {
        session.data.weight = w;
        session.data.bmi = (w / ((session.data.height/100)**2)).toFixed(1);
        session.step = 'prevBirth';
        reply = `Have you *ever given birth* to a child, ${session.name}?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      }
      break;
    }

    case 'prevBirth': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.prevBirth = ans;
        session.step = 'cycleReg';
        reply = `Are your *periods usually regular* (every 21–35 days)?`;
        sendWithButtons(res, reply, [{title:'Regular'}, {title:'Irregular'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'cycleReg': {
      let ans = lower === '1' ? 'regular' : (lower === '2' ? 'irregular' : lower);
      if (ans === 'regular' || ans === 'irregular') {
        session.data.cycleReg = ans;
        session.step = 'pcos';
        reply = `Have you been diagnosed with *PCOS*?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Regular, 2 for Irregular.';
      break;
    }

    case 'pcos': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.pcos = ans;
        session.step = 'endo';
        reply = `Have you been diagnosed with *endometriosis*?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'endo': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.endo = ans;
        session.step = 'thyroid';
        reply = `Do you have a *thyroid condition*?`;
        sendWithButtons(res, reply, [{title:'No'}, {title:'Treated'}, {title:'Untreated'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'thyroid': {
      let ans = lower === '1' ? 'no' : (lower === '2' ? 'treated' : (lower === '3' ? 'untreated' : lower));
      if (['no','treated','untreated'].includes(ans)) {
        session.data.thyroid = ans;
        session.step = 'diabetes';
        reply = `Have you been diagnosed with *diabetes* (Type 1 or 2)?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 (No), 2 (Treated), 3 (Untreated).';
      break;
    }

    case 'diabetes': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.diabetes = ans;
        session.step = 'smoking';
        reply = `Do you currently *smoke*?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'smoking': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.smoking = ans;
        session.step = 'alcohol';
        reply = `Do you drink *more than 7 alcoholic drinks per week*?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'alcohol': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.alcohol = ans;
        session.step = 'tryDuration';
        reply = `How long have you been *trying to conceive*?`;
        sendWithButtons(res, reply, [{title:'<12 months'}, {title:'≥12 months'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'tryDuration': {
      let ans = lower === '1' ? 'under12' : (lower === '2' ? 'over12' : lower);
      if (ans === 'under12' || ans === 'over12') {
        session.data.tryDuration = ans;
        session.step = 'stiHistory';
        reply = `Have you ever had *chlamydia or gonorrhoea* (an STI)?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for <12 months, 2 for 12+ months.';
      break;
    }

    case 'stiHistory': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.stiHistory = ans;
        session.step = 'pelvicSurgery';
        reply = `Have you had *pelvic surgery* (e.g., for cysts, fibroids, appendix)?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'pelvicSurgery': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.pelvicSurgery = ans;
        session.step = 'familyEarlyMenopause';
        reply = `Does your *mother or sister* have early menopause (before 45)?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'familyEarlyMenopause': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.familyEarlyMenopause = ans;
        session.step = 'recreationalDrugs';
        reply = `Do you use *recreational drugs* (e.g., marijuana, cocaine)?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'recreationalDrugs': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.recreationalDrugs = ans;
        session.step = 'caffeine';
        reply = `Do you consume *more than 2 cups of coffee per day* (>200mg caffeine)?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'caffeine': {
      let ans = lower === '1' ? 'high' : (lower === '2' ? 'low' : lower);
      if (ans === 'high' || ans === 'low') {
        session.data.caffeine = ans;
        session.step = 'cancerTreatment';
        reply = `Have you ever had *chemotherapy or radiation* treatment?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'cancerTreatment': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.cancerTreatment = ans;
        session.step = 'tbPersonal';
        reply = `Have you ever been diagnosed with *tuberculosis (TB)* of any kind?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}, {title:'Unsure'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'tbPersonal': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : (lower === '3' ? 'unsure' : lower));
      if (['yes','no','unsure'].includes(ans)) {
        session.data.tbPersonal = ans;
        session.step = 'tbContact';
        reply = `Have you lived in *close contact* with someone who had active TB?`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No, 3 for Unsure.';
      break;
    }

    case 'tbContact': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes' || ans === 'no') {
        session.data.tbContact = ans;
        session.step = 'labToggle';
        reply = `Do you have recent *lab results* (AMH, FSH, AFC)? (Optional)`;
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }

    case 'labToggle': {
      let ans = lower === '1' ? 'yes' : (lower === '2' ? 'no' : lower);
      if (ans === 'yes') {
        session.data.includeLab = true;
        session.step = 'amhValue';
        reply = `Please enter your *AMH* value and unit. E.g., *2.5 ng/mL* or *18 pmol/L*.`;
      } else if (ans === 'no') {
        session.data.includeLab = false;
        // Build report and go to PDF consent
        const reportText = buildReport({ ...session.data, name: session.name });
        session.data.risk_category = determineRiskCategory({...session.data});
        session.data.risk_report = reportText;
        // Save lead immediately (email unknown yet)
        await saveLeadToSupabase({ ...session.data, name: session.name, phone: from, email: null, consent_marketing: false });
        reply = reportText;
        session.step = 'pdfConsent';
      } else {
        reply = 'Please reply 1 for Yes, 2 for No.';
      }
      break;
    }

    case 'amhValue': {
      let parts = incomingMsg.split(' ');
      let val = parseFloat(parts[0]);
      let unit = parts.length > 1 ? parts[1].replace('/','') : 'ng/mL';
      if (isNaN(val) || val <= 0) {
        reply = 'Please enter a valid number, e.g., 2.5 ng/mL.';
      } else {
        session.data.amhValue = val;
        session.data.amhUnit = unit.toLowerCase() === 'pmol/l' ? 'pmol/L' : 'ng/mL';
        session.step = 'fsh';
        reply = `Now enter your *FSH* (IU/L), measured on day 2-4 of cycle.`;
      }
      break;
    }

    case 'fsh': {
      let val = parseFloat(incomingMsg);
      if (isNaN(val) || val <= 0) {
        reply = 'Please enter a valid FSH number.';
      } else {
        session.data.fsh = val;
        session.step = 'afc';
        reply = `And your *Antral Follicle Count (AFC)* from ultrasound.`;
      }
      break;
    }

    case 'afc': {
      let val = parseInt(incomingMsg);
      if (isNaN(val) || val < 0) {
        reply = 'Please enter a valid AFC count (0 or higher).';
      } else {
        session.data.afc = val;
        const reportText = buildReport({ ...session.data, name: session.name });
        session.data.risk_category = determineRiskCategory({...session.data});
        session.data.risk_report = reportText;
        await saveLeadToSupabase({ ...session.data, name: session.name, phone: from, email: null, consent_marketing: false });
        reply = reportText;
        session.step = 'pdfConsent';
      }
      break;
    }

    // PDF consent step
    case 'pdfConsent':
      if (lower === 'yes' || lower === '1') {
        session.step = 'emailForReport';
        reply = `Please provide your *email address* to receive the report, and I'll also send it here on WhatsApp.`;
      } else {
        session.step = 'clinicConsent';
        reply = `Can we share your details with fertility clinics for personalised options? (Reply Yes/No)`;
      }
      break;

    case 'emailForReport': {
      if (!incomingMsg.includes('@')) {
        reply = 'That doesn\'t look like a valid email. Please try again.';
      } else {
        session.data.email = incomingMsg;
        // Update lead with email
        await supabase.from('leads').update({ email: session.data.email }).match({ phone: from });
        try {
          const pdfBuffer = await generateReportPDF({ ...session.data, name: session.name });
          const filename = `report_${from.replace(/\D/g, '')}_${Date.now()}.pdf`;
          const publicUrl = await uploadPDF(pdfBuffer, filename);
          // Send WhatsApp media
          const twimlMsg = new MessagingResponse();
          twimlMsg.message('Here is your fertility report.').media(publicUrl);
          // Send email concurrently (don't block)
          sendEmail(session.data.email, 'Your Fertility Report', 'Please find your fertility risk report attached.', pdfBuffer)
            .then(() => console.log('Email sent'))
            .catch(err => console.error('Email error:', err));
          // Send WhatsApp media response
          res.writeHead(200, { 'Content-Type': 'text/xml' });
          res.end(twimlMsg.toString());
          return;
        } catch (err) {
          console.error('PDF/email error:', err);
          reply = 'Sorry, something went wrong while generating your report. Our team will send it manually.';
        }
        session.step = 'clinicConsent';
        reply += ' Can we share your details with fertility clinics? (Reply Yes/No)';
      }
      break;
    }

    case 'clinicConsent':
      if (lower === 'yes' || lower === '1') {
        await supabase.from('leads').update({ consent_marketing: true }).match({ phone: from });
        reply = `✅ Thank you, ${session.name}! A fertility advisor may reach out with options.`;
      } else {
        reply = `Understood, ${session.name}. Your data will not be shared.`;
      }
      session.step = 'done';
      break;

    default:
      reply = 'Type *restart* to start over.';
  }

  twiml.message(reply);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

// ---------- WEB WIDGET API ----------
app.post('/api/leads', async (req, res) => {
  const data = req.body;
  if (!data.email || !data.name) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  const riskCategory = determineRiskCategory(data);
  const report = buildReport({ ...data, name: data.name });
  const success = await saveLeadToSupabase({
    ...data,
    source: 'web_widget',
    risk_category: riskCategory,
    risk_report: report,
    phone: data.phone || null,
    consent_marketing: true,
  });
  if (success) return res.status(201).json({ success: true });
  return res.status(500).json({ error: 'Database error' });
});

app.get('/', (req, res) => res.send('Fertility Bot API is running.'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
