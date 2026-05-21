// server.js – FertiSTAT + AAFA model
const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ========== RISK ASSESSMENT (FertiSTAT colour bands) ==========
function classifyRiskFactor(factor, value) {
  // Returns: { level: 'green'|'amber'|'red', label: string }
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
      return value === 'yes' ? { level: 'red', label: 'Heavy alcohol intake' } : { level: 'green', label: 'Low/no alcohol' };
    case 'tryDuration':
      return value === 'over12' ? { level: 'red', label: 'Trying ≥12 months' } : { level: 'amber', label: 'Trying <12 months' };
    case 'stiHistory':
      return value === 'yes' ? { level: 'red', label: 'History of STI (possible tubal damage)' } : { level: 'green', label: 'No STI history' };
    case 'pelvicSurgery':
      return value === 'yes' ? { level: 'red', label: 'Previous pelvic surgery' } : { level: 'green', label: 'No pelvic surgery' };
    case 'familyEarlyMenopause':
      return value === 'yes' ? { level: 'red', label: 'Family history of early menopause' } : { level: 'green', label: 'No family history' };
    case 'recreationalDrugs':
      return value === 'yes' ? { level: 'red', label: 'Recreational drug use' } : { level: 'green', label: 'No recreational drugs' };
    case 'caffeine':
      return value === 'high' ? { level: 'amber', label: 'High caffeine (>200 mg/day)' } : { level: 'green', label: 'Low/moderate caffeine' };
    case 'cancerTreatment':
      return value === 'yes' ? { level: 'red', label: 'History of cancer treatment' } : { level: 'green', label: 'No cancer treatment' };
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

// ========== AAFA Ovarian Reserve Model (published) ==========
function assessOvarianReserve(amh, fsh, afc, age) {
  // Clusters based on Xu et al. 2020
  let reserve = 'adequate';
  let cluster = 'A';
  if ((amh < 1.0 && fsh > 10) || (amh < 0.5) || (afc <= 5)) {
    reserve = 'severely reduced';
    cluster = 'D';
  } else if ((amh >= 0.5 && amh < 1.0 && fsh <= 10) || (afc >= 5 && afc <= 7)) {
    reserve = 'moderately reduced';
    cluster = 'C';
  } else if ((amh >= 1.0 && amh < 2.0 && fsh < 8) || (afc >= 7 && afc <= 10)) {
    reserve = 'mildly reduced';
    cluster = 'B';
  }
  return { reserve, cluster };
}

function buildReport(sessionData) {
  const factors = {
    age: sessionData.age,
    bmi: sessionData.bmi || (sessionData.height && sessionData.weight ? (sessionData.weight / ((sessionData.height/100)**2)).toFixed(1) : null),
    prevBirth: sessionData.prevBirth,
    cycleReg: sessionData.cycleReg,
    pcos: sessionData.pcos,
    endo: sessionData.endo,
    thyroid: sessionData.thyroid,
    diabetes: sessionData.diabetes,
    smoking: sessionData.smoking,
    alcohol: sessionData.alcohol,
    tryDuration: sessionData.tryDuration,
    stiHistory: sessionData.stiHistory,
    pelvicSurgery: sessionData.pelvicSurgery,
    familyEarlyMenopause: sessionData.familyEarlyMenopause,
    recreationalDrugs: sessionData.recreationalDrugs,
    caffeine: sessionData.caffeine,
    cancerTreatment: sessionData.cancerTreatment
  };

  const category = determineRiskCategory(factors);
  let report = `📊 *Fertility Risk Assessment*\n\n`;
  report += `Overall risk: *${category.toUpperCase()}*\n\n`;
  report += `Factors identified:\n`;
  for (const [factor, value] of Object.entries(factors)) {
    const { level, label } = classifyRiskFactor(factor, value);
    if (level !== 'green') {
      const emoji = level === 'red' ? '🔴' : '🟠';
      report += `${emoji} ${label}\n`;
    }
  }
  report += `\n`;

  // Personalised guidance
  if (category === 'high') {
    report += `➡️ *Recommendation:* Prompt specialist consultation advised.\n`;
  } else if (category === 'medium') {
    report += `➡️ *Recommendation:* Consider lifestyle changes and consult if not pregnant within 6–12 months.\n`;
  } else {
    report += `➡️ *Recommendation:* Fertility potential appears favourable. Continue timed intercourse.\n`;
  }

  // Ovarian reserve if labs present
  if (sessionData.amhValue || sessionData.fsh || sessionData.afc) {
    const { reserve, cluster } = assessOvarianReserve(
      parseFloat(sessionData.amhValue) || null,
      parseFloat(sessionData.fsh) || null,
      parseInt(sessionData.afc) || null,
      sessionData.age
    );
    report += `\n🔬 *Ovarian Reserve (AAFA model)*: ${reserve} (Cluster ${cluster})\n`;
    if (cluster === 'D') report += `This indicates a high probability of poor ovarian response.\n`;
  }

  report += `\n⚠️ This is not a diagnosis. Always consult a fertility specialist.`;
  return report;
}

// ========== SAVE TO SUPABASE (unchanged) ==========
async function saveLeadToSupabase(data) {
  const { error } = await supabase.from('leads').insert([{
    source: data.source,
    age: data.age,
    height: data.height,
    weight: data.weight,
    bmi: data.bmi,
    prev_birth: data.prevBirth,
    cycle_reg: data.cycleReg,
    pcos: data.pcos,
    endometriosis: data.endo,
    thyroid: data.thyroid,
    diabetes: data.diabetes,
    smoking: data.smoking,
    alcohol: data.alcohol,
    try_duration: data.tryDuration,
    sti_history: data.stiHistory,
    pelvic_surgery: data.pelvicSurgery,
    family_early_menopause: data.familyEarlyMenopause,
    recreational_drugs: data.recreationalDrugs,
    caffeine: data.caffeine,
    cancer_treatment: data.cancerTreatment,
    lab_amh: data.lab_amh || null,
    lab_amh_unit: data.lab_amh_unit || null,
    lab_fsh: data.lab_fsh || null,
    lab_afc: data.lab_afc || null,
    risk_category: data.risk_category,
    name: data.name || null,
    email: data.email || null,
    phone: data.phone || null,
    country: data.country || null,
    consent_marketing: data.consent_marketing || false,
    consent_research: false
  }]);
  if (error) console.error('Supabase error:', error);
  return !error;
}

// ========== WHATSAPP BOT (updated flow) ==========
const sessions = new Map();

function startFlow(session) {
  session.step = 'age';
  return `🌸 *Fertility Check‑In*\n\nI'll ask a few questions to assess your fertility risk. All answers are confidential.\nFirst, *what is your age?*`;
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
  // ... (the full step-by-step flow with new questions integrated, identical structure but extended)
  // For brevity, I'll provide the full file separately. I'll instruct the user to replace the entire file.
  // To keep this response manageable, I'll give the full server.js as a separate code block later.
});

// ... rest of server code (API, listen) same as before ...
