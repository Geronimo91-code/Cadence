// GET /api/calendar?u=<uid>&t=<calToken> — iCal feed of this week's and next week's sessions with 1-hour reminders
import { db, weekId, weekIdOffset, mondayOf } from './_lib.js';

export default async function handler(req, res) {
  const { u, t } = req.query || {};
  if (!u || !t) return res.status(400).send('Missing parameters');
  const userDoc = await db().doc(`users/${u}`).get();
  if (!userDoc.exists || userDoc.data().calToken !== t) return res.status(403).send('Invalid calendar link');
  const profile = userDoc.data().profile || {};
  const [hh, mm] = (profile.sessionTime || '18:00').split(':').map(Number);
  const tz = profile.timezone || 'Europe/Brussels';
  const ids = [weekId(), weekIdOffset(weekId(), 1)];
  const plans = (await Promise.all(ids.map((id) => db().doc(`users/${u}/plans/${id}`).get()))).filter((d) => d.exists).map((d) => d.data());

  const pad = (n) => String(n).padStart(2, '0');
  const fmtLocal = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(hh)}${pad(mm)}00`;
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Cadence//Training//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Cadence training', `X-WR-TIMEZONE:${tz}`];
  for (const plan of plans) {
    const mon = mondayOf(plan.weekId);
    for (const s of plan.sessions) {
      if (s.type === 'rest') continue;
      const day = new Date(mon); day.setUTCDate(mon.getUTCDate() + s.day);
      const start = fmtLocal(day);
      const endD = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm + (s.durationMin || 60)));
      const end = `${endD.getUTCFullYear()}${pad(endD.getUTCMonth() + 1)}${pad(endD.getUTCDate())}T${pad(endD.getUTCHours())}${pad(endD.getUTCMinutes())}00`;
      const desc = [s.intent, '', ...(s.exercises || []).map((x) => `• ${x.name} ${x.sets ? x.sets + '×' : ''}${x.reps}${x.load ? ' · ' + x.load : ''}`)].join('\n');
      lines.push('BEGIN:VEVENT', `UID:cadence-${u}-${plan.weekId}-${s.day}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
        `DTSTART;TZID=${tz}:${start}`, `DTEND;TZID=${tz}:${end}`, `SUMMARY:${esc('Cadence · ' + s.title)}`, `DESCRIPTION:${esc(desc)}`,
        'BEGIN:VALARM', 'TRIGGER:-PT60M', 'ACTION:DISPLAY', `DESCRIPTION:${esc(s.title)} in 1 hour`, 'END:VALARM', 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).send(lines.join('\r\n'));
}
