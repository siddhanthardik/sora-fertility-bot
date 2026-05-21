const express = require('express');
const { MessagingResponse } = require('twilio').twiml;
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ---------- SCORING (unchanged) ----------
const SCORE_MAX = 100;
const deductionWeights = {
  age:        { ranges: [[18,29,0],[30,34,10],[35,37,20],[38,40,30],[41,55,40]] },
  bmi:        { ranges: [[18.5,24.9,0],[15,18.4,5],[25,29.9,5],[30,50,10]] },
  prevBirth:  { no: 15, yes: 0 },
  cycleReg:   { irregular: 10, regular: 0 },
  pcos:       { yes: 10, no: 0 },
  endo:       { yes: 10, no: 0 },
  thyroid:    { untreated: 5, treated: 0, no: 0 },
  diabetes:   { yes: 10, no: 0 },
  smoking:    { yes: 10, no: 0 },
  alcohol:    { yes: 5, no: 0 },
  tryDuration:{ over12: 5, under12: 0 }
};

function scoreFromAMH(amh, unit) {
  let val = parseFloat(amh);
  if (isNaN(val)) return null;
  if (unit === 'pmol/L') val = val / 7.14;
  if (val >= 2.0) return 100;
  if (val >= 1.0) return 80;
  if (val >= 0.5) return 60;
  return 40;
}
function scoreFromFSH(fsh) {
  let val = parseFloat(fsh);
  if (isNaN(val)) return null;
  if (val < 8) return 100;
  if (val <= 10) return 80;
  if (val <= 15) return 60;
  return 40;
}
function scoreFromAFC(afc) {
  let val = parseInt(afc);
  if (isNaN(val)) return null;
  if (val > 15) return 100;
  if (val >= 10) return 80;
  if (val >= 5) return 60;
  return 40;
}
function getAgeDeduction(age) {
  let a = parseInt(age);
  for (let [min,max,ded] of deductionWeights.age.ranges)
    if (a >= min && a <= max) return ded;
  return 40;
}
function getBMIDeduction(bmi) {
  for (let [min,max,ded] of deductionWeights.bmi.ranges)
    if (bmi >= min && bmi <= max) return ded;
  return 0;
}
function calculateBasicScore(data) {
  let deductions = 0;
  deductions += getAgeDeduction(data.age);
  let bmi = data.bmi || (data.height && data.weight ? data.weight / ((data.height/100)**2) : 0);
  deductions += getBMIDeduction(bmi);
  deductions += data.prevBirth === 'no' ? 15 : 0;
  deductions += data.cycleReg === 'irregular' ? 10 : 0;
  deductions += data.pcos === 'yes' ? 10 : 0;
  deductions += data.endo === 'yes' ? 10 : 0;
  if (data.thyroid === 'untreated') deductions += 5;
  deductions += data.diabetes === 'yes' ? 10 : 0;
  deductions += data.smoking === 'yes' ? 10 : 0;
  deductions += data.alcohol === 'yes' ? 5 : 0;
  deductions += data.tryDuration === 'over12' ? 5 : 0;
  return Math.max(0, SCORE_MAX - deductions);
}
function calculateEnhancedScore(data) {
  let base = calculateBasicScore(data);
  let reserveScores = [];
  if (data.amhValue) { let s = scoreFromAMH(data.amhValue, data.amhUnit); if (s !== null) reserveScores.push(s); }
  if (data.fsh) { let s = scoreFromFSH(data.fsh); if (s !== null) reserveScores.push(s); }
  if (data.afc) { let s = scoreFromAFC(data.afc); if (s !== null) reserveScores.push(s); }
  let reserveAvg = reserveScores.length ? reserveScores.reduce((a,b)=>a+b,0) / reserveScores.length : 100;
  return Math.round(Math.min(100, Math.max(0, base * 0.6 + reserveAvg * 0.4)));
}
function getInterpretation(score) {
  if (score >= 75) return { band: 'High', text: 'Fertility potential appears high. Timing intercourse to ovulation may be sufficient.' };
  if (score >= 50) return { band: 'Moderate', text: 'Moderate fertility potential. Consider lifestyle changes and consult if not pregnant within 6–12 months.' };
  if (score >= 25) return { band: 'Low', text: 'Fertility potential is low. A specialist evaluation is strongly recommended.' };
  return { band: 'Very Low', text: 'Fertility potential is very low. Prompt medical assessment is advised.' };
}

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
    lab_amh: data.lab_amh || null,
    lab_amh_unit: data.lab_amh_unit || null,
    lab_fsh: data.lab_fsh || null,
    lab_afc: data.lab_afc || null,
    basic_score: data.basic_score,
    enhanced_score: data.enhanced_score || null,
    name: data.name || null,
    email: data.email || null,
    phone: data.phone || null,
    country: data.country || null,
    consent_marketing: data.consent_marketing || false,
    consent_research: false
  }]);
  if (error) {
    console.error('Supabase insert error:', error);
    return false;
  }
  return true;
}

// ---------- HELPER: send message with quick reply buttons ----------
function sendWithButtons(res, bodyText, buttons) {
  const twiml = new MessagingResponse();
  // For WhatsApp, we can simulate quick replies by listing options in the body
  // Twilio's native MessagingResponse doesn't support native buttons, but we can
  // format the message to show numbered options clearly.
  let optionsText = buttons.map((b, i) => `${i+1}. ${b.title}`).join('\n');
  twiml.message(`${bodyText}\n\n${optionsText}`);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
}

// ---------- WHATSAPP BOT ----------
const sessions = new Map();

function startFlow(session) {
  session.step = 'age';
  return `🌸 *Fertility Check‑In*\n\nI'll ask a few questions to estimate your fertility score. All answers are confidential. First, *what is your age?* (just reply with a number)`;
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

  // Handle restart
  if (incomingMsg === 'restart' || incomingMsg === 'start over') {
    session.step = 'welcome';
    session.data = {};
    twiml.message(startFlow(session));
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    return res.end(twiml.toString());
  }

  // --- For quick reply buttons: we'll map numeric answers ---
  // Users can still type the word, but buttons will send number. We'll handle both.

  let reply = '';

  switch (session.step) {
    case 'welcome':
      reply = startFlow(session);
      twiml.message(reply);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
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

    // For the rest, we'll use sendWithButtons for yes/no questions

    case 'prevBirth': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes' || ans === 'no') {
        session.data.prevBirth = ans;
        session.step = 'cycleReg';
        reply = 'Are your *periods usually regular* (every 21–35 days)?';
        sendWithButtons(res, reply, [{title:'Regular'}, {title:'Irregular'}]);
        return;
      } else { reply = 'Please reply with 1 for Yes or 2 for No.'; }
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
      } else { reply = 'Please reply 1 for Regular, 2 for Irregular.'; }
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
      } else { reply = 'Please reply 1 for Yes, 2 for No.'; }
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
      } else { reply = 'Please reply 1 for Yes, 2 for No.'; }
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
      } else { reply = 'Please reply 1 (No), 2 (Treated), or 3 (Untreated).'; }
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
      } else { reply = 'Please reply 1 for Yes, 2 for No.'; }
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
      } else { reply = 'Please reply 1 for Yes, 2 for No.'; }
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
      } else { reply = 'Please reply 1 for Yes, 2 for No.'; }
      break;
    }

    case 'tryDuration': {
      let ans = incomingMsg === '1' ? 'under12' : (incomingMsg === '2' ? 'over12' : incomingMsg);
      if (ans === 'under12' || ans === 'over12') {
        session.data.tryDuration = ans;
        session.step = 'labToggle';
        reply = 'Do you have recent *lab results* (AMH, FSH, AFC)?';
        sendWithButtons(res, reply, [{title:'Yes'}, {title:'No'}]);
        return;
      } else { reply = 'Please reply 1 for under 12 months, 2 for 12+ months.'; }
      break;
    }

    case 'labToggle': {
      let ans = incomingMsg === '1' ? 'yes' : (incomingMsg === '2' ? 'no' : incomingMsg);
      if (ans === 'yes') {
        session.data.includeLab = true;
        session.step = 'amhValue';
        reply = 'Please enter your *AMH* value and unit. For example: *2.5 ng/mL* or *18 pmol/L*.';
      } else if (ans === 'no') {
        session.data.includeLab = false;
        // Immediately show score and move to lead capture
        const basicScore = calculateBasicScore(session.data);
        const enhancedScore = null;
        session.data.basic_score = basicScore;
        session.data.enhanced_score = enhancedScore;
        reply = showScore(session.data);
        twiml.message(reply);
        // After showing score, ask for lead name
        session.step = 'leadName';
        // Send the lead name prompt right after score (but we can't send two messages in one response, so we'll ask for name now)
        // We already sent the score, so we need to send the name prompt next time. We'll set step to 'leadName' and the next message will trigger that case.
        // But the current response is already sent. So we just end here; the next user message will trigger 'leadName' case.
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
        // All lab done – show score and go to lead
        const basicScore = calculateBasicScore(session.data);
        const enhancedScore = calculateEnhancedScore(session.data);
        session.data.basic_score = basicScore;
        session.data.enhanced_score = enhancedScore;
        reply = showScore(session.data);
        session.step = 'leadName';
      }
      break;
    }

    // Lead capture steps
    case 'leadName':
      reply = 'Would you like to receive *personalised clinic options*? If yes, please tell me your name. (Type *skip* to decline)';
      // We will move to name collection after user reply, so set step to 'name'
      session.step = 'name';
      break;

    case 'name': {
      if (incomingMsg === 'skip') {
        session.step = 'done';
        reply = 'No problem! You can always restart by typing *restart*. 🌸';
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
        reply = 'What *country* are you based in? (e.g., India, USA) – this helps us find the right clinics.';
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
        session.data.consentGiven = true;
        // Save to Supabase
        await saveLeadToSupabase({
          source: 'whatsapp',
          age: session.data.age,
          height: session.data.height,
          weight: session.data.weight,
          bmi: session.data.bmi,
          prevBirth: session.data.prevBirth,
          cycleReg: session.data.cycleReg,
          pcos: session.data.pcos,
          endo: session.data.endo,
          thyroid: session.data.thyroid,
          diabetes: session.data.diabetes,
          smoking: session.data.smoking,
          alcohol: session.data.alcohol,
          tryDuration: session.data.tryDuration,
          lab_amh: session.data.amhValue || null,
          lab_amh_unit: session.data.amhUnit || null,
          lab_fsh: session.data.fsh || null,
          lab_afc: session.data.afc || null,
          basic_score: session.data.basic_score,
          enhanced_score: session.data.enhanced_score || null,
          name: session.data.leadName || null,
          email: session.data.leadEmail || null,
          phone: null,
          country: session.data.leadCountry || null,
          consent_marketing: true,
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

  // Fallback: send plain text if not already sent by quick-reply handler
  twiml.message(reply);
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

function showScore(data) {
  let score;
  if (data.includeLab && (data.amhValue || data.fsh || data.afc)) {
    score = calculateEnhancedScore(data);
  } else {
    score = calculateBasicScore(data);
  }
  const interp = getInterpretation(score);
  return `📊 *Your Fertility Score: ${score}/100* – *${interp.band} Potential*\n\n${interp.text}\n\n⚠️ This is not a diagnosis.`;
}

// ---------- Web widget API (unchanged) ----------
app.post('/api/leads', async (req, res) => {
  const data = req.body;
  if (!data.email || !data.name) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  const success = await saveLeadToSupabase({
    source: 'web_widget',
    age: data.age,
    height: data.height,
    weight: data.weight,
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
    lab_amh: data.lab_amh || null,
    lab_amh_unit: data.lab_amh_unit || null,
    lab_fsh: data.lab_fsh || null,
    lab_afc: data.lab_afc || null,
    basic_score: data.basic_score,
    enhanced_score: data.enhanced_score || null,
    name: data.name,
    email: data.email,
    phone: data.phone || null,
    country: data.country,
    consent_marketing: true,
    consent_research: false
  });
  if (success) {
    return res.status(201).json({ success: true });
  } else {
    return res.status(500).json({ error: 'Database error' });
  }
});

app.get('/', (req, res) => res.send('Fertility Bot API is running.'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
