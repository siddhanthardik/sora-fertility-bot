const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ---------- RISK FACTOR CLASSIFICATION (FertiSTAT bands) ----------
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
    bmi: data.bmi || (data.height && data.weight ? (data.weight / ((data.height/100)**2)).toFixed(1) : null),
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
    cancerTreatment: data.cancerTreatment
  };
  const category = determineRiskCategory(factors);
  let report = `📊 *Fertility Risk Assessment*\n\nOverall risk: *${category.toUpperCase()}*\n\nFactors identified:\n`;
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
  report += `\n`;
  if (category === 'high') {
    report += `➡️ *Recommendation:* Prompt specialist consultation advised.\n`;
  } else if (category === 'medium') {
    report += `➡️ *Recommendation:* Lifestyle changes and consultation if not pregnant within 6–12 months.\n`;
  } else {
    report += `➡️ *Recommendation:* Fertility potential appears favourable. Continue timed intercourse.\n`;
  }
  if (data.amhValue || data.fsh || data.afc) {
    const amh = data.amhValue ? parseFloat(data.amhValue) : null;
    const fsh = data.fsh ? parseFloat(data.fsh) : null;
    const afc = data.afc ? parseInt(data.afc) : null;
    const { reserve, cluster } = assessOvarianReserve(amh, fsh, afc);
    report += `\n🔬 *Ovarian Reserve (AAFA model)*: ${reserve} (Cluster ${cluster})\n`;
    if (cluster === 'D') report += `This indicates a high probability of poor ovarian response.\n`;
  }
  report += `\n⚠️ This is not a diagnosis. Consult a fertility specialist.`;
  return report;
}

async function saveLeadToSupabase(data) {
  const { error } = await supabase.from('leads').insert([{
    source: data.source,
    age: data.age, height: data.height, weight: data.weight, bmi: data.bmi,
    prev_birth: data.prevBirth, cycle_reg: data.cycleReg, pcos: data.pcos,
    endometriosis: data.endo, thyroid: data.thyroid, diabetes: data.diabetes,
    smoking: data.smoking, alcohol: data.alcohol, try_duration: data.tryDuration,
    sti_history: data.stiHistory, pelvic_surgery: data.pelvicSurgery,
    family_early_menopause: data.familyEarlyMenopause,
    recreational_drugs: data.recreationalDrugs, caffeine: data.caffeine,
    cancer_treatment: data.cancerTreatment,
    lab_amh: data.lab_amh || null, lab_amh_unit: data.lab_amh_unit || null,
    lab_fsh: data.lab_fsh || null, lab_afc: data.lab_afc || null,
    risk_category: data.risk_category,
    name: data.name || null, email: data.email || null,
    phone: data.phone || null, country: data.country || null,
    consent_marketing: data.consent_marketing || false, consent_research: false
  }]);
  if (error) console.error('Supabase error:', error);
  return !error;
}

// ---------- HELPER: Quick reply buttons ----------
function sendWithButtons(res, bodyText, buttons) {
  const twiml = new MessagingResponse();
  let optionsText = buttons.map((b, i) => `${i+1}. ${b.title}`).join('\n');
  twiml.message(`${bodyText}\n\n${optionsText}`);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
}

// ---------- WHATSAPP BOT ----------
const sessions = new Map();
function startFlow(session) {
  session.step = 'age';
  return `🌸 *Fertility Check‑In*\n\nI'll ask questions to assess your fertility risk. All answers are confidential. First, *what is your age?* (just reply with a number)`;
}

app.post('/whatsapp', async (req, res) => {
  const twiml = new MessagingResponse();
  const from = req.body.From;
  const incomingMsg = req.body.Body.trim().toLowerCase();
  let session = sessions.get(from);
  if (!session) {
    session = { step: 'welcome', data: {} };
    sessions.set(from, session);
  }
  if (incomingMsg === 'restart') {
    session.step = 'welcome'; session.data = {};
    twiml.message(startFlow(session));
    return res.end(twiml.toString());
  }

  let reply = '';
  switch (session.step) {
    case 'welcome':
      reply = startFlow(session);
      twiml.message(reply);
      return res.end(twiml.toString());
    case 'age': {
      let age = parseInt(incomingMsg);
      if (isNaN(age) || age < 18 || age > 55) {
        reply = 'Please enter a valid age between 18 and 55.';
      } else {
        session.data.age = age;
        session.step = 'height';
        reply = 'Next, *what is your height in cm?* (e.g., 165)';
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
        reply = 'And *what is your weight in kg?* (e.g., 68)';
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
        reply = 'Have you *ever given birth* to a child?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      }
      break;
    }
    case 'prevBirth': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.prevBirth = ans;
        session.step = 'cycleReg';
        reply = 'Are your *periods usually regular* (every 21–35 days)?';
        sendWithButtons(res, reply, [{title:'Regular'}, {title:'Irregular'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'cycleReg': {
      let ans = incomingMsg === '1' ? 'regular' : (incomingMsg === '2' ? 'irregular' : incomingMsg);
      if (ans === 'regular' || ans === 'irregular') {
        session.data.cycleReg = ans;
        session.step = 'pcos';
        reply = 'Have you been diagnosed with *PCOS*?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Regular, 2 for Irregular.';
      break;
    }
    case 'pcos': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.pcos = ans;
        session.step = 'endo';
        reply = 'Have you been diagnosed with *endometriosis*?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'endo': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.endo = ans;
        session.step = 'thyroid';
        reply = 'Do you have a *thyroid condition*?';
        sendWithButtons(res, reply, [{title:'No'}, {title:'Treated'}, {title:'Untreated'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'thyroid': {
      let ans = incomingMsg === '1' ? 'no' : (incomingMsg === '2' ? 'treated' : (incomingMsg === '3' ? 'untreated' : incomingMsg));
      if (['no','treated','untreated'].includes(ans)) {
        session.data.thyroid = ans;
        session.step = 'diabetes';
        reply = 'Have you been diagnosed with *diabetes* (Type 1 or 2)?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 (No), 2 (Treated), 3 (Untreated).';
      break;
    }
    case 'diabetes': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.diabetes = ans;
        session.step = 'smoking';
        reply = 'Do you currently *smoke*?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'smoking': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.smoking = ans;
        session.step = 'alcohol';
        reply = 'Do you drink *more than 7 alcoholic drinks per week*?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'alcohol': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.alcohol = ans;
        session.step = 'tryDuration';
        reply = 'How long have you been *trying to conceive*?';
        sendWithButtons(res, reply, [{title:'<12 months'}, {title:'≥12 months'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'tryDuration': {
      let ans = incomingMsg === '1' ? 'under12' : (incomingMsg === '2' ? 'over12' : incomingMsg);
      if (ans === 'under12' || ans === 'over12') {
        session.data.tryDuration = ans;
        session.step = 'stiHistory';
        reply = 'Have you ever had *chlamydia or gonorrhoea* (an STI)?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for <12 months, 2 for 12+ months.';
      break;
    }
    case 'stiHistory': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.stiHistory = ans;
        session.step = 'pelvicSurgery';
        reply = 'Have you had *pelvic surgery* (e.g., for ovarian cysts, fibroids, appendix)?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'pelvicSurgery': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.pelvicSurgery = ans;
        session.step = 'familyEarlyMenopause';
        reply = 'Does your *mother or sister* have a history of early menopause (before 45)?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'familyEarlyMenopause': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.familyEarlyMenopause = ans;
        session.step = 'recreationalDrugs';
        reply = 'Do you use *recreational drugs* (e.g., marijuana, cocaine)?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'recreationalDrugs': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.recreationalDrugs = ans;
        session.step = 'caffeine';
        reply = 'Do you consume *more than 2 cups of coffee (or equivalent) per day*?';
        sendWithButtons(res, reply, [{title:'Yes (>200mg)'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'caffeine': {
      let ans = incomingMsg === '1' ? 'high' : (incomingMsg === '2' ? 'low' : incomingMsg);
      if (ans === 'high' || ans === 'low') {
        session.data.caffeine = ans;
        session.step = 'cancerTreatment';
        reply = 'Have you ever had *chemotherapy or radiation* treatment?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'cancerTreatment': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.cancerTreatment = ans;
        session.step = 'labToggle';
        reply = 'Do you have recent *lab results* (AMH, FSH, AFC)? (Optional)';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else reply = 'Please reply 1 for Yes, 2 for No.';
      break;
    }
    case 'labToggle': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes') {
        session.data.includeLab = true;
        session.step = 'amhValue';
        reply = 'Please enter your *AMH* value and unit. E.g., *2.5 ng/mL* or *18 pmol/L*.';
      } else if (ans === 'no') {
        session.data.includeLab = false;
        reply = buildReport(session.data);
        session.step = 'leadName';
      } else reply = 'Please reply 1 for Yes, 2 for No.';
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
        reply = 'Now enter your *FSH* (IU/L), measured on day 2-4 of cycle.';
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
        reply = 'And your *Antral Follicle Count (AFC)* from ultrasound.';
      }
      break;
    }
    case 'afc': {
      let val = parseInt(incomingMsg);
      if (isNaN(val) || val < 0) {
        reply = 'Please enter a valid AFC count (0 or higher).';
      } else {
        session.data.afc = val;
        reply = buildReport(session.data);
        session.step = 'leadName';
      }
      break;
    }
    case 'leadName':
      reply = 'Would you like to receive *personalised clinic options*? If yes, please tell me your name. (Type *skip* to decline)';
      session.step = 'name';
      break;
    case 'name': {
      if (incomingMsg === 'skip') {
        session.step = 'done';
        reply = 'No problem! Type *restart* to try again. 🌸';
      } else {
        session.data.leadName = incomingMsg;
        session.step = 'email';
        reply = 'Thanks! What\'s your *email address*? (type *skip* if you prefer not to share)';
      }
      break;
    }
    case 'email': {
      if (incomingMsg === 'skip') {
        session.step = 'country';
        reply = 'What *country* are you based in? (e.g., India, USA)';
      } else {
        if (!incomingMsg.includes('@')) {
          reply = 'That doesn\'t look like a valid email. Please try again or type *skip*.';
        } else {
          session.data.leadEmail = incomingMsg;
          session.step = 'country';
          reply = 'Great. Now, what *country* are you based in?';
        }
      }
      break;
    }
    case 'country': {
      if (incomingMsg === 'skip') {
        session.step = 'consent';
        reply = 'Finally, can we use your data to match you with clinics and send you information?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else {
        session.data.leadCountry = incomingMsg;
        session.step = 'consent';
        reply = 'Can we use your data to *match you with clinics and send information*?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      }
      break;
    }
    case 'consent': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes') {
        session.data.risk_category = determineRiskCategory({
          age: session.data.age, bmi: session.data.bmi, prevBirth: session.data.prevBirth,
          cycleReg: session.data.cycleReg, pcos: session.data.pcos, endo: session.data.endo,
          thyroid: session.data.thyroid, diabetes: session.data.diabetes, smoking: session.data.smoking,
          alcohol: session.data.alcohol, tryDuration: session.data.tryDuration,
          stiHistory: session.data.stiHistory, pelvicSurgery: session.data.pelvicSurgery,
          familyEarlyMenopause: session.data.familyEarlyMenopause,
          recreationalDrugs: session.data.recreationalDrugs, caffeine: session.data.caffeine,
          cancerTreatment: session.data.cancerTreatment
        });
        await saveLeadToSupabase({
          source: 'whatsapp',
          age: session.data.age, height: session.data.height, weight: session.data.weight,
          bmi: session.data.bmi, prevBirth: session.data.prevBirth, cycleReg: session.data.cycleReg,
          pcos: session.data.pcos, endo: session.data.endo, thyroid: session.data.thyroid,
          diabetes: session.data.diabetes, smoking: session.data.smoking, alcohol: session.data.alcohol,
          tryDuration: session.data.tryDuration, stiHistory: session.data.stiHistory,
          pelvicSurgery: session.data.pelvicSurgery, familyEarlyMenopause: session.data.familyEarlyMenopause,
          recreationalDrugs: session.data.recreationalDrugs, caffeine: session.data.caffeine,
          cancerTreatment: session.data.cancerTreatment,
          lab_amh: session.data.amhValue || null, lab_amh_unit: session.data.amhUnit || null,
          lab_fsh: session.data.fsh || null, lab_afc: session.data.afc || null,
          risk_category: session.data.risk_category,
          name: session.data.leadName || null, email: session.data.leadEmail || null,
          phone: null, country: session.data.leadCountry || null,
          consent_marketing: true
        });
        reply = '✅ We have received your details. A fertility advisor may reach out with options. Thank you!';
      } else {
        reply = 'Understood. Your data will not be used for marketing. Thank you for using the tool.';
      }
      session.step = 'done';
      break;
    }
    default:
      reply = 'You can type *restart* to start over.';
  }
  twiml.message(reply);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

app.post('/api/leads', async (req, res) => {
  const data = req.body;
  if (!data.email || !data.name) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  const riskCategory = determineRiskCategory({
    age: data.age, bmi: data.bmi, prevBirth: data.prevBirth,
    cycleReg: data.cycleReg, pcos: data.pcos, endo: data.endo,
    thyroid: data.thyroid, diabetes: data.diabetes, smoking: data.smoking,
    alcohol: data.alcohol, tryDuration: data.tryDuration,
    stiHistory: data.stiHistory, pelvicSurgery: data.pelvicSurgery,
    familyEarlyMenopause: data.familyEarlyMenopause,
    recreationalDrugs: data.recreationalDrugs, caffeine: data.caffeine,
    cancerTreatment: data.cancerTreatment
  });
  const success = await saveLeadToSupabase({
    source: 'web_widget',
    age: data.age, height: data.height, weight: data.weight, bmi: data.bmi,
    prevBirth: data.prevBirth, cycleReg: data.cycleReg, pcos: data.pcos,
    endo: data.endo, thyroid: data.thyroid, diabetes: data.diabetes,
    smoking: data.smoking, alcohol: data.alcohol, tryDuration: data.tryDuration,
    stiHistory: data.stiHistory, pelvicSurgery: data.pelvicSurgery,
    familyEarlyMenopause: data.familyEarlyMenopause,
    recreationalDrugs: data.recreationalDrugs, caffeine: data.caffeine,
    cancerTreatment: data.cancerTreatment,
    lab_amh: data.lab_amh || null, lab_amh_unit: data.lab_amh_unit || null,
    lab_fsh: data.lab_fsh || null, lab_afc: data.lab_afc || null,
    risk_category: riskCategory,
    name: data.name, email: data.email, phone: data.phone || null,
    country: data.country, consent_marketing: true
  });
  if (success) return res.status(201).json({ success: true });
  return res.status(500).json({ error: 'Database error' });
});

app.get('/', (req, res) => res.send('Fertility Bot API is running.'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
