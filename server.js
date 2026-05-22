// server.js – FertiSTAT + AAFA + Name-Once + Enhanced Report
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ========== RISK CLASSIFICATION (FertiSTAT colour bands) ==========
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
      return value === 'yes' ? { level: 'red', label: 'History of STI (possible tubal damage)' } : { level: 'green', label: 'No STI history' };
    case 'pelvicSurgery':
      return value === 'yes' ? { level: 'red', label: 'Previous pelvic surgery' } : { level: 'green', label: 'No pelvic surgery' };
    case 'familyEarlyMenopause':
      return value === 'yes' ? { level: 'red', label: 'Family history of early menopause' } : { level: 'green', label: 'No family history' };
    case 'recreationalDrugs':
      return value === 'yes' ? { level: 'red', label: 'Recreational drug use' } : { level: 'green', label: 'No drugs' };
    case 'caffeine':
      return value === 'high' ? { level: 'amber', label: 'High caffeine (>200mg/day)' } : { level: 'green', label: 'Low/moderate caffeine' };
    case 'cancerTreatment':
      return value === 'yes' ? { level: 'red', label: 'History of cancer treatment' } : { level: 'green', label: 'No cancer treatment' };
    default: return { level: 'green', label: '' };
  }
}

function determineRiskCategory(factors) {
  let red = 0, amber = 0;
  for (const [k, v] of Object.entries(factors)) {
    const { level } = classifyRiskFactor(k, v);
    if (level === 'red') red++;
    else if (level === 'amber') amber++;
  }
  if (red >= 2 || (red === 1 && amber >= 3)) return 'high';
  if (red === 1 || amber >= 3) return 'medium';
  return 'low';
}

function assessOvarianReserve(amh, fsh, afc) {
  if (!amh && !fsh && !afc) return null;
  let reserve = 'adequate', cluster = 'A';
  if ((amh && amh < 0.5) || (fsh && fsh > 15) || (afc && afc <= 5)) {
    reserve = 'severely reduced'; cluster = 'D';
  } else if ((amh && amh < 1.0) || (fsh && fsh > 10) || (afc && afc <= 7)) {
    reserve = 'moderately reduced'; cluster = 'C';
  } else if ((amh && amh < 2.0) || (fsh && fsh > 8) || (afc && afc <= 10)) {
    reserve = 'mildly reduced'; cluster = 'B';
  }
  return { reserve, cluster };
}

function buildWhatsAppReport(data) {
  const factors = {
    age: data.age, bmi: data.bmi, prevBirth: data.prevBirth,
    cycleReg: data.cycleReg, pcos: data.pcos, endo: data.endo,
    thyroid: data.thyroid, diabetes: data.diabetes, smoking: data.smoking,
    alcohol: data.alcohol, tryDuration: data.tryDuration,
    stiHistory: data.stiHistory, pelvicSurgery: data.pelvicSurgery,
    familyEarlyMenopause: data.familyEarlyMenopause,
    recreationalDrugs: data.recreationalDrugs, caffeine: data.caffeine,
    cancerTreatment: data.cancerTreatment
  };
  const category = determineRiskCategory(factors);
  let report = `📊 *Your Fertility Risk Assessment*\n\n`;
  report += `Overall risk level: *${category.toUpperCase()}*\n\n`;
  report += `🔍 Key findings:\n`;
  for (const [k, v] of Object.entries(factors)) {
    const { level, label } = classifyRiskFactor(k, v);
    if (level !== 'green') {
      const emoji = level === 'red' ? '🔴' : '🟠';
      report += `${emoji} ${label}\n`;
    }
  }
  const labs = assessOvarianReserve(
    parseFloat(data.amhValue) || null,
    parseFloat(data.fsh) || null,
    parseInt(data.afc) || null
  );
  if (labs) {
    report += `\n🔬 Ovarian Reserve: ${labs.reserve} (Cluster ${labs.cluster})\n`;
  }
  report += `\n⚠️ This is a screening tool, not a medical diagnosis.`;
  return report;
}

// ========== DATABASE ==========
async function saveLead(data) {
  const { error } = await supabase.from('leads').insert([{
    report_id: data.report_id,
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
    name: data.name || null, email: data.email || null, phone: data.phone || null,
    country: data.country || null,
    consent_marketing: data.consent_marketing || false,
  }]);
  if (error) { console.error('Supabase error:', error); return false; }
  return true;
}

async function updateLead(reportId, updates) {
  const { error } = await supabase.from('leads').update(updates).eq('report_id', reportId);
  if (error) console.error('Update error:', error);
  return !error;
}

// ========== WHATSAPP BOT ==========
const sessions = new Map();

function startFlow(session) {
  session.step = 'userName';
  return `🌸 *Fertility Check‑In*\n\nI'll ask a few questions to assess your fertility risk. All answers are confidential.\nFirst, *what is your name?* (type *skip* if you prefer to remain anonymous)`;
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

  const isYes = (msg) => msg === '1' || msg === 'yes';
  const isNo = (msg) => msg === '2' || msg === 'no';
  let reply = '';

  // Helper to send quick reply
  function sendYesNo(res, twiml, text) {
    twiml.message(`${text}\n\n1. Yes\n2. No`);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }

  switch (session.step) {
    case 'welcome':
      reply = startFlow(session);
      break;

    // ----- NAME (first) -----
    case 'userName':
      if (incomingMsg === 'skip') {
        session.data.userName = null;
      } else {
        session.data.userName = incomingMsg;
      }
      session.step = 'age';
      reply = 'Now, *what is your age?* (just reply with a number)';
      break;

    // ----- Demographics -----
    case 'age': {
      const age = parseInt(incomingMsg);
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
      const h = parseFloat(incomingMsg);
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
      const w = parseFloat(incomingMsg);
      if (isNaN(w) || w < 30 || w > 250) {
        reply = 'Please enter a valid weight in kg (30–250).';
      } else {
        session.data.weight = w;
        session.data.bmi = (w / ((session.data.height/100)**2)).toFixed(1);
        session.step = 'prevBirth';
        reply = 'Have you *ever given birth* to a child?';
        sendYesNo(res, twiml, reply);
        return;
      }
      break;
    }

    // ----- Medical History (Yes/No) -----
    case 'prevBirth': {
      if (isYes(incomingMsg)) session.data.prevBirth = 'yes';
      else if (isNo(incomingMsg)) session.data.prevBirth = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'cycleReg';
      reply = 'Are your *periods usually regular* (every 21–35 days)?';
      twiml.message(`${reply}\n\n1. Regular\n2. Irregular`);
      res.end(twiml.toString());
      return;
    }

    case 'cycleReg': {
      if (incomingMsg === '1' || incomingMsg === 'regular') session.data.cycleReg = 'regular';
      else if (incomingMsg === '2' || incomingMsg === 'irregular') session.data.cycleReg = 'irregular';
      else { reply = 'Please reply 1 for Regular, 2 for Irregular.'; break; }
      session.step = 'pcos';
      reply = 'Have you been diagnosed with *PCOS*?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'pcos': {
      if (isYes(incomingMsg)) session.data.pcos = 'yes';
      else if (isNo(incomingMsg)) session.data.pcos = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'endo';
      reply = 'Have you been diagnosed with *endometriosis*?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'endo': {
      if (isYes(incomingMsg)) session.data.endo = 'yes';
      else if (isNo(incomingMsg)) session.data.endo = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'thyroid';
      reply = 'Do you have a *thyroid condition*?';
      twiml.message(`${reply}\n\n1. No\n2. Yes, treated\n3. Yes, untreated`);
      res.end(twiml.toString());
      return;
    }

    case 'thyroid': {
      if (incomingMsg === '1' || incomingMsg === 'no') session.data.thyroid = 'no';
      else if (incomingMsg === '2' || incomingMsg === 'treated') session.data.thyroid = 'treated';
      else if (incomingMsg === '3' || incomingMsg === 'untreated') session.data.thyroid = 'untreated';
      else { reply = 'Please reply 1 (No), 2 (Treated), or 3 (Untreated).'; break; }
      session.step = 'diabetes';
      reply = 'Have you been diagnosed with *diabetes* (Type 1 or 2)?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'diabetes': {
      if (isYes(incomingMsg)) session.data.diabetes = 'yes';
      else if (isNo(incomingMsg)) session.data.diabetes = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'smoking';
      reply = 'Do you currently *smoke*?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'smoking': {
      if (isYes(incomingMsg)) session.data.smoking = 'yes';
      else if (isNo(incomingMsg)) session.data.smoking = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'alcohol';
      reply = 'Do you drink *more than 7 alcoholic drinks per week*?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'alcohol': {
      if (isYes(incomingMsg)) session.data.alcohol = 'yes';
      else if (isNo(incomingMsg)) session.data.alcohol = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'tryDuration';
      reply = 'How long have you been *trying to conceive*?';
      twiml.message(`${reply}\n\n1. Less than 12 months\n2. 12 months or longer`);
      res.end(twiml.toString());
      return;
    }

    case 'tryDuration': {
      if (incomingMsg === '1' || incomingMsg === 'under12') session.data.tryDuration = 'under12';
      else if (incomingMsg === '2' || incomingMsg === 'over12') session.data.tryDuration = 'over12';
      else { reply = 'Please reply 1 (<12 months) or 2 (≥12 months).'; break; }
      session.step = 'stiHistory';
      reply = 'Have you ever had a *sexually transmitted infection* (e.g., chlamydia, gonorrhoea)?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'stiHistory': {
      if (isYes(incomingMsg)) session.data.stiHistory = 'yes';
      else if (isNo(incomingMsg)) session.data.stiHistory = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'pelvicSurgery';
      reply = 'Have you had any *pelvic surgery* (e.g., ovarian cyst removal, fibroids)?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'pelvicSurgery': {
      if (isYes(incomingMsg)) session.data.pelvicSurgery = 'yes';
      else if (isNo(incomingMsg)) session.data.pelvicSurgery = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'familyEarlyMenopause';
      reply = 'Does your mother or sister have a history of *early menopause* (before age 45)?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'familyEarlyMenopause': {
      if (isYes(incomingMsg)) session.data.familyEarlyMenopause = 'yes';
      else if (isNo(incomingMsg)) session.data.familyEarlyMenopause = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'recreationalDrugs';
      reply = 'Do you use *recreational drugs* (e.g., marijuana, cocaine)?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'recreationalDrugs': {
      if (isYes(incomingMsg)) session.data.recreationalDrugs = 'yes';
      else if (isNo(incomingMsg)) session.data.recreationalDrugs = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'caffeine';
      reply = 'Do you consume *more than 200 mg of caffeine per day*? (≈ 2 cups of coffee)';
      twiml.message(`${reply}\n\n1. High (>200mg)\n2. Low/Moderate`);
      res.end(twiml.toString());
      return;
    }

    case 'caffeine': {
      if (incomingMsg === '1' || incomingMsg === 'high') session.data.caffeine = 'high';
      else if (incomingMsg === '2' || incomingMsg === 'low') session.data.caffeine = 'low';
      else { reply = 'Please reply 1 (High) or 2 (Low).'; break; }
      session.step = 'cancerTreatment';
      reply = 'Have you ever had *chemotherapy or radiation therapy*?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'cancerTreatment': {
      if (isYes(incomingMsg)) session.data.cancerTreatment = 'yes';
      else if (isNo(incomingMsg)) session.data.cancerTreatment = 'no';
      else { reply = 'Please reply 1 for Yes, 2 for No.'; break; }
      session.step = 'labToggle';
      reply = 'Do you have recent *lab results* (AMH, FSH, AFC)?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'labToggle': {
      if (isYes(incomingMsg)) {
        session.data.includeLab = true;
        session.step = 'amhValue';
        reply = 'Please enter your *AMH* value and unit. For example: *2.5 ng/mL* or *18 pmol/L*.';
      } else if (isNo(incomingMsg)) {
        session.data.includeLab = false;
        reply = buildWhatsAppReport(session.data);
        twiml.message(reply);
        session.step = 'askReport';
        res.end(twiml.toString());
        return;
      } else {
        reply = 'Please reply 1 for Yes, 2 for No.';
      }
      break;
    }

    case 'amhValue': {
      const parts = incomingMsg.split(' ');
      const val = parseFloat(parts[0]);
      const unit = parts.length > 1 ? parts[1].replace('/', '') : 'ng/mL';
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
      const val = parseFloat(incomingMsg);
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
      const val = parseInt(incomingMsg);
      if (isNaN(val) || val < 0) {
        reply = 'Please enter a valid AFC count (0 or higher).';
      } else {
        session.data.afc = val;
        reply = buildWhatsAppReport(session.data);
        twiml.message(reply);
        session.step = 'askReport';
        res.end(twiml.toString());
        return;
      }
      break;
    }

    // ===== REPORT & CONSULTATION (reuse name/email) =====
    case 'askReport': {
      if (isYes(incomingMsg)) {
        // If we already have userName (not skip), use it; otherwise ask
        if (session.data.userName) {
          session.data.reportName = session.data.userName;
          session.step = 'reportEmail';
          reply = 'What is your *email address* to receive the report? (type *skip*)';
        } else {
          session.step = 'reportName';
          reply = 'Please enter your *full name* for the report.';
        }
      } else if (isNo(incomingMsg)) {
        session.step = 'askConsultation';
        reply = 'Would you like a *free consultation* with a fertility advisor?';
        sendYesNo(res, twiml, reply);
        return;
      } else {
        reply = 'Please reply 1 for Yes, 2 for No.';
      }
      break;
    }

    case 'reportName': {
      session.data.reportName = incomingMsg;
      session.step = 'reportEmail';
      reply = 'What is your *email address* to receive the report? (type *skip*)';
      break;
    }

    case 'reportEmail': {
      session.data.reportEmail = incomingMsg === 'skip' ? null : incomingMsg;
      // Generate report and save lead
      const reportId = crypto.randomUUID().slice(0, 8);
      session.data.reportId = reportId;
      const riskCategory = determineRiskCategory({
        age: session.data.age, bmi: session.data.bmi, prevBirth: session.data.prevBirth,
        cycleReg: session.data.cycleReg, pcos: session.data.pcos, endo: session.data.endo,
        thyroid: session.data.thyroid, diabetes: session.data.diabetes, smoking: session.data.smoking,
        alcohol: session.data.alcohol, tryDuration: session.data.tryDuration,
        stiHistory: session.data.stiHistory, pelvicSurgery: session.data.pelvicSurgery,
        familyEarlyMenopause: session.data.familyEarlyMenopause,
        recreationalDrugs: session.data.recreationalDrugs, caffeine: session.data.caffeine,
        cancerTreatment: session.data.cancerTreatment
      });
      session.data.riskCategory = riskCategory;
      const saved = await saveLead({
        report_id: reportId,
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
        risk_category: riskCategory,
        name: session.data.reportName || session.data.userName || null,
        email: session.data.reportEmail,
        consent_marketing: false,
      });
      if (saved) {
        reply = `✅ Your report is ready!\n\n👉 View & download here:\nhttps://sora-fertility-bot.onrender.com/report/${reportId}`;
      } else {
        reply = 'Sorry, something went wrong. Please try again later.';
        session.step = 'done';
        break;
      }
      session.step = 'askConsultation';
      twiml.message(reply);
      res.end(twiml.toString());
      return;
    }

    case 'askConsultation': {
      if (isYes(incomingMsg)) {
        // Check if we already have name/email from report or userName
        const name = session.data.reportName || session.data.userName;
        const email = session.data.reportEmail;
        if (name && email) {
          // All info available, skip to consent
          session.data.consultName = name;
          session.data.consultEmail = email;
          session.step = 'consultConsent';
          reply = 'Can we share your details with a fertility advisor?';
          sendYesNo(res, twiml, reply);
          return;
        } else if (name && !email) {
          session.data.consultName = name;
          session.step = 'consultEmail';
          reply = 'What is your *email address* for the advisor to contact you? (type *skip*)';
        } else if (!name && email) {
          session.data.consultEmail = email;
          session.step = 'consultName';
          reply = 'Please enter your *full name* for the consultation.';
        } else {
          session.step = 'consultName';
          reply = 'Please enter your *full name*.';
        }
      } else if (isNo(incomingMsg)) {
        session.step = 'done';
        reply = 'Thank you for using the tool. You can always restart by typing *restart*.';
      } else {
        reply = 'Please reply 1 for Yes, 2 for No.';
      }
      break;
    }

    case 'consultName': {
      session.data.consultName = incomingMsg;
      // If we already have email from report, go to consent; else ask email
      if (session.data.reportEmail) {
        session.data.consultEmail = session.data.reportEmail;
        session.step = 'consultConsent';
        reply = 'Can we share your details with a fertility advisor?';
        sendYesNo(res, twiml, reply);
        return;
      } else {
        session.step = 'consultEmail';
        reply = 'What is your *email address*? (type *skip*)';
      }
      break;
    }

    case 'consultEmail': {
      session.data.consultEmail = incomingMsg === 'skip' ? null : incomingMsg;
      session.step = 'consultConsent';
      reply = 'Can we share your details with a fertility advisor?';
      sendYesNo(res, twiml, reply);
      return;
    }

    case 'consultConsent': {
      if (isYes(incomingMsg)) {
        // Update lead or insert new if no report
        const name = session.data.consultName || session.data.reportName || session.data.userName;
        const email = session.data.consultEmail || session.data.reportEmail;
        if (session.data.reportId) {
          await updateLead(session.data.reportId, {
            consent_marketing: true,
            name: name,
            email: email,
          });
        } else {
          // No report, create new lead
          const reportId = crypto.randomUUID().slice(0, 8);
          const riskCategory = determineRiskCategory({...});
          await saveLead({
            report_id: reportId,
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
            risk_category: riskCategory,
            name: name, email: email, consent_marketing: true,
          });
          session.data.reportId = reportId;
        }
        reply = '✅ A fertility advisor will contact you soon. Thank you!';
      } else {
        reply = 'Understood. Your data will not be shared.';
      }
      session.step = 'done';
      break;
    }

    case 'done':
      reply = 'You can type *restart* to start over.';
      break;

    default:
      reply = 'You can type *restart* to start over.';
  }

  if (!res.headersSent) {
    twiml.message(reply);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
  sessions.set(from, session);
});

// ========== ENHANCED REPORT PAGE ==========
app.get('/report/:id', async (req, res) => {
  const { data, error } = await supabase.from('leads').select('*').eq('report_id', req.params.id).single();
  if (error || !data) return res.status(404).send('Report not found');

  // Build factor list with explanations
  const factorDetails = [
    { key: 'age', label: 'Age', value: data.age, explanation: 'Female fertility declines with age, especially after 35, due to decreasing egg quantity and quality.' },
    { key: 'bmi', label: 'BMI', value: data.bmi, explanation: 'Being underweight or overweight can disrupt ovulation and hormonal balance.' },
    { key: 'prev_birth', label: 'Previous live birth', value: data.prev_birth, explanation: 'A previous successful pregnancy is a positive indicator of fertility.' },
    { key: 'cycle_reg', label: 'Menstrual cycles', value: data.cycle_reg, explanation: 'Irregular cycles often indicate problems with ovulation.' },
    { key: 'pcos', label: 'PCOS', value: data.pcos, explanation: 'Polycystic Ovary Syndrome is a common cause of ovulatory infertility.' },
    { key: 'endometriosis', label: 'Endometriosis', value: data.endometriosis, explanation: 'This condition can affect egg quality, tubal function, and implantation.' },
    { key: 'thyroid', label: 'Thyroid condition', value: data.thyroid, explanation: 'Thyroid imbalances can interfere with ovulation and increase miscarriage risk.' },
    { key: 'diabetes', label: 'Diabetes', value: data.diabetes, explanation: 'Poorly controlled diabetes can reduce fertility and increase pregnancy complications.' },
    { key: 'smoking', label: 'Smoking', value: data.smoking, explanation: 'Smoking accelerates ovarian ageing and damages eggs.' },
    { key: 'alcohol', label: 'Heavy alcohol', value: data.alcohol, explanation: 'Excessive alcohol intake is linked to ovulatory disorders and reduced fertility.' },
    { key: 'try_duration', label: 'Time trying to conceive', value: data.try_duration, explanation: 'A longer duration of trying suggests underlying factors that may need medical help.' },
    { key: 'sti_history', label: 'STI history', value: data.sti_history, explanation: 'Certain STIs can cause tubal blockage and infertility.' },
    { key: 'pelvic_surgery', label: 'Pelvic surgery', value: data.pelvic_surgery, explanation: 'Previous pelvic surgery may lead to adhesions or scarring that affect fertility.' },
    { key: 'family_early_menopause', label: 'Family early menopause', value: data.family_early_menopause, explanation: 'A family history of early menopause may indicate a genetic predisposition to diminished ovarian reserve.' },
    { key: 'recreational_drugs', label: 'Recreational drugs', value: data.recreational_drugs, explanation: 'Substance use can impair ovulation and sperm quality.' },
    { key: 'caffeine', label: 'Caffeine intake', value: data.caffeine, explanation: 'High caffeine consumption (>200mg/day) has been associated with delayed conception.' },
    { key: 'cancer_treatment', label: 'Cancer treatment', value: data.cancer_treatment, explanation: 'Chemotherapy and radiation can be toxic to ovaries and reduce fertility.' }
  ];

  let factorRows = '';
  factorDetails.forEach(f => {
    const { level, label } = classifyRiskFactor(f.key, f.value);
    const color = level === 'red' ? '#b0454a' : (level === 'amber' ? '#d4776a' : '#6b8f71');
    const emoji = level === 'red' ? '🔴' : (level === 'amber' ? '🟠' : '🟢');
    factorRows += `
      <tr>
        <td style="padding:8px;">${emoji} ${f.label}</td>
        <td style="padding:8px; color:${color}; font-weight:bold;">${label}</td>
        <td style="padding:8px; font-size:0.9rem;">${f.explanation}</td>
      </tr>`;
  });

  // Ovarian reserve section
  let labSection = '';
  if (data.lab_amh || data.lab_fsh || data.lab_afc) {
    const labs = assessOvarianReserve(data.lab_amh, data.lab_fsh, data.lab_afc);
    if (labs) {
      labSection = `
        <div style="background:#f0f7f0; padding:15px; border-radius:10px; margin:20px 0;">
          <h3>🔬 Ovarian Reserve (AAFA Model)</h3>
          <p>Based on your AMH, FSH, and AFC, your ovarian reserve is estimated as:</p>
          <p style="font-size:1.2rem; font-weight:bold;">${labs.reserve} (Cluster ${labs.cluster})</p>
          <p>This model helps predict response to ovarian stimulation and can guide fertility planning.</p>
        </div>`;
    }
  }

  // Risk wheel chart (simple CSS circle)
  const riskColor = data.risk_category === 'high' ? '#b0454a' : (data.risk_category === 'medium' ? '#d4776a' : '#6b8f71');
  const wheelHTML = `
    <div style="display:flex; justify-content:center; margin:20px 0;">
      <div style="width:120px; height:120px; border-radius:50%; background: conic-gradient(${riskColor} 0deg 360deg, #eee 0deg); display:flex; align-items:center; justify-content:center;">
        <div style="background:white; width:90px; height:90px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:bold; font-size:1.5rem; color:${riskColor};">
          ${data.risk_category.toUpperCase()}
        </div>
      </div>
    </div>`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fertility Risk Report</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 700px; margin: 30px auto; padding: 20px; background:#fafafa; }
  .header { background: #f0f7f0; padding: 25px; border-radius: 16px; text-align:center; }
  .risk-wheel { margin: 15px auto; }
  table { width:100%; border-collapse:collapse; margin:20px 0; }
  th { background:#f5f5f5; text-align:left; padding:10px; }
  td { border-bottom:1px solid #eee; }
  .disclaimer { margin-top:30px; font-size:0.9rem; color:#666; border-top:2px solid #ccc; padding-top:15px; }
  @media print { body { background:white; } .print-btn { display:none; } }
  .print-btn { display:inline-block; margin:20px 0; background: #6b8f71; color: white; border: none; padding: 12px 25px; border-radius: 8px; font-size:1rem; cursor: pointer; }
</style>
</head>
<body>
  <div class="header">
    <h1>🌸 Fertility Risk Report</h1>
    <p>Report ID: <strong>${data.report_id}</strong></p>
    <p>Generated on: ${new Date().toLocaleDateString()}</p>
  </div>

  ${wheelHTML}

  <h2>Overall Risk: <span style="color:${riskColor}">${data.risk_category.toUpperCase()}</span></h2>

  <h3>Your Risk Factors Explained</h3>
  <table>
    <tr><th>Factor</th><th>Status</th><th>What it means</th></tr>
    ${factorRows}
  </table>

  ${labSection}

  <div style="margin:25px 0;">
    <h3>Personalised Recommendations</h3>
    ${data.risk_category === 'high' 
      ? '<p>🔴 Multiple significant risk factors were identified. <strong>Prompt consultation with a fertility specialist is strongly advised.</strong> Early assessment can help preserve options and improve outcomes.</p>'
      : data.risk_category === 'medium'
      ? '<p>🟠 Some factors may affect your fertility. Consider lifestyle changes where possible, and consult a doctor if you do not conceive within 6–12 months.</p>'
      : '<p>🟢 Your fertility potential appears favourable. Continue timed intercourse and a healthy lifestyle. If you are over 35 and do not conceive within 6 months, consider a check‑up.</p>'}
  </div>

  <button class="print-btn" onclick="window.print()">🖨️ Print / Save as PDF</button>

  <div class="disclaimer">
    <strong>Disclaimer:</strong> This report is generated by a screening tool based on the FertiSTAT risk assessment model and, where applicable, the AAFA ovarian reserve classification. It is <strong>not a medical diagnosis</strong> and does not replace individualised advice from a qualified healthcare professional. Always consult a fertility specialist for a full evaluation and personalised guidance. The creators of this tool assume no liability for decisions made based on this report.
  </div>
</body>
</html>`;

  res.send(html);
});

// ========== API endpoint for web widget ==========
app.post('/api/leads', async (req, res) => {
  const data = req.body;
  const reportId = crypto.randomUUID().slice(0, 8);
  const success = await saveLead({ ...data, report_id: reportId, source: data.source || 'web_widget' });
  if (success) {
    res.status(201).json({ success: true, reportId });
  } else {
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/', (req, res) => res.send('Fertility Bot API is running.'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
