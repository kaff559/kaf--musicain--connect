'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const {
  requireAuth, requireRole, notify, serializeJobPosting, serializeJobResponse,
} = require('../lib/helpers');

function loadJob(id) {
  const j = db.prepare('SELECT * FROM job_postings WHERE id = ?').get(id);
  if (!j) throw new HttpError(404, 'Job posting not found');
  return j;
}

function register(router) {
  // Client posts an opening.
  router.post('/api/jobs', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const b = ctx.body;
    if (!b.title || !String(b.title).trim()) throw new HttpError(400, 'Title is required');
    if (!b.eventDate) throw new HttpError(400, 'eventDate is required');

    const info = db.prepare(
      `INSERT INTO job_postings (client_user_id, title, category, description, event_date, event_time,
       city, state, country, event_type, pay_rate, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
    ).run(
      user.id, String(b.title).trim(), b.category || null, b.description || '', b.eventDate,
      b.eventTime || null, b.city || null, b.state || null, b.country || null,
      b.eventType || null, b.payRate || null
    );
    return { job: serializeJobPosting(loadJob(info.lastInsertRowid)) };
  });

  // Browse open postings — talent-facing, same filter shape as /api/musicians
  // (category, eventType, city/state/country) so it feels consistent.
  router.get('/api/jobs', async (ctx) => {
    const category = ctx.query.category || null;
    const eventType = ctx.query.eventType || null;
    const explicitCity = ctx.query.city || null;
    const explicitState = ctx.query.state || null;
    const explicitCountry = ctx.query.country || null;
    const q = (ctx.query.q || '').toLowerCase().trim();

    let rows = db.prepare(
      `SELECT jp.*, u.name AS client_name FROM job_postings jp JOIN users u ON u.id = jp.client_user_id
       WHERE jp.status = 'open' AND u.suspended = 0 ORDER BY jp.event_date ASC, jp.created_at DESC`
    ).all();

    if (category) rows = rows.filter((r) => (r.category || '').toLowerCase() === category.toLowerCase());
    if (eventType) rows = rows.filter((r) => r.event_type === eventType);
    if (explicitCity) rows = rows.filter((r) => (r.city || '').toLowerCase().includes(explicitCity.toLowerCase()));
    if (explicitState) rows = rows.filter((r) => (r.state || '').toLowerCase().includes(explicitState.toLowerCase()));
    if (explicitCountry) rows = rows.filter((r) => (r.country || '').toLowerCase().includes(explicitCountry.toLowerCase()));
    if (q) {
      rows = rows.filter((r) => [r.title, r.description, r.category, r.city, r.state, r.country]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
    }

    const jobs = rows.map((r) => ({ ...serializeJobPosting(r), clientName: r.client_name }));
    return { jobs };
  });

  // Client's own postings, each with its responses attached so the dashboard
  // can show them inline without a round-trip per posting.
  router.get('/api/jobs/mine', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const rows = db.prepare('SELECT * FROM job_postings WHERE client_user_id = ? ORDER BY created_at DESC').all(user.id);
    const jobs = rows.map((j) => {
      const responses = db.prepare(
        `SELECT jr.*, mp.stage_name, mp.photo_url, mp.hourly_rate, u.name AS user_name
         FROM job_responses jr
         JOIN musician_profiles mp ON mp.id = jr.musician_profile_id
         JOIN users u ON u.id = mp.user_id
         WHERE jr.job_posting_id = ? ORDER BY jr.created_at ASC`
      ).all(j.id);
      return {
        ...serializeJobPosting(j),
        responses: responses.map((r) => ({
          ...serializeJobResponse(r),
          stageName: r.stage_name || r.user_name,
          photoUrl: r.photo_url,
          hourlyRate: r.hourly_rate,
        })),
      };
    });
    return { jobs };
  });

  // Talent's own responses across jobs, with the job's own info attached —
  // for the "My Job Responses" dashboard tab.
  router.get('/api/jobs/my-responses', async (ctx) => {
    const user = requireRole(ctx, 'musician');
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(user.id);
    if (!profile) return { responses: [] };
    const rows = db.prepare(
      `SELECT jr.*, jp.title, jp.event_date, jp.event_time, jp.city, jp.state, jp.country,
       jp.status AS job_status, jp.pay_rate
       FROM job_responses jr JOIN job_postings jp ON jp.id = jr.job_posting_id
       WHERE jr.musician_profile_id = ? ORDER BY jr.created_at DESC`
    ).all(profile.id);
    return {
      responses: rows.map((r) => ({
        ...serializeJobResponse(r),
        jobTitle: r.title,
        jobEventDate: r.event_date,
        jobEventTime: r.event_time,
        jobCity: r.city,
        jobState: r.state,
        jobCountry: r.country,
        jobStatus: r.job_status,
        jobPayRate: r.pay_rate,
      })),
    };
  });

  router.get('/api/jobs/:id', async (ctx) => {
    const job = loadJob(ctx.params.id);
    const client = db.prepare('SELECT name FROM users WHERE id = ?').get(job.client_user_id);
    let myResponse = null;
    if (ctx.user && ctx.user.role === 'musician') {
      const profile = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(ctx.user.id);
      if (profile) {
        const r = db.prepare('SELECT * FROM job_responses WHERE job_posting_id = ? AND musician_profile_id = ?').get(job.id, profile.id);
        myResponse = serializeJobResponse(r);
      }
    }
    return { job: { ...serializeJobPosting(job), clientName: client ? client.name : null }, myResponse };
  });

  // Client closes a posting early (found someone outside the platform, event
  // cancelled, etc.) without necessarily accepting any particular response.
  router.post('/api/jobs/:id/close', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const job = loadJob(ctx.params.id);
    if (job.client_user_id !== user.id) throw new HttpError(403, 'Not your job posting');
    if (job.status !== 'open') throw new HttpError(400, `Job posting is already ${job.status}`);
    db.prepare("UPDATE job_postings SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(job.id);
    const pending = db.prepare("SELECT * FROM job_responses WHERE job_posting_id = ? AND status = 'pending'").all(job.id);
    pending.forEach((r) => {
      db.prepare("UPDATE job_responses SET status='declined' WHERE id=?").run(r.id);
      const mp = db.prepare('SELECT user_id FROM musician_profiles WHERE id = ?').get(r.musician_profile_id);
      if (mp) notify(mp.user_id, `The job posting "${job.title}" was closed by the poster.`, 'job');
    });
    return { job: serializeJobPosting(loadJob(job.id)) };
  });

  // Talent responds to a posting.
  router.post('/api/jobs/:id/respond', async (ctx) => {
    const user = requireRole(ctx, 'musician');
    const job = loadJob(ctx.params.id);
    if (job.status !== 'open') throw new HttpError(400, 'This job posting is no longer open');
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(user.id);
    if (!profile) throw new HttpError(404, 'Musician profile not found');
    const existing = db.prepare('SELECT id FROM job_responses WHERE job_posting_id = ? AND musician_profile_id = ?').get(job.id, profile.id);
    if (existing) throw new HttpError(409, 'You already responded to this job posting');

    const info = db.prepare(
      "INSERT INTO job_responses (job_posting_id, musician_profile_id, message, status) VALUES (?, ?, ?, 'pending')"
    ).run(job.id, profile.id, ctx.body.message || null);
    notify(job.client_user_id, `${profile.stage_name || user.name} responded to your job posting "${job.title}"`, 'job');
    const row = db.prepare('SELECT * FROM job_responses WHERE id = ?').get(info.lastInsertRowid);
    return { response: serializeJobResponse(row) };
  });

  // Client accepts or declines one response. Accepting marks the job
  // "filled" and auto-declines every other still-pending response on it —
  // mirrors how a real posting stops taking applicants once someone's hired.
  router.post('/api/jobs/:id/responses/:responseId/respond', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const job = loadJob(ctx.params.id);
    if (job.client_user_id !== user.id) throw new HttpError(403, 'Not your job posting');
    const response = db.prepare('SELECT * FROM job_responses WHERE id = ? AND job_posting_id = ?').get(ctx.params.responseId, job.id);
    if (!response) throw new HttpError(404, 'Response not found');
    if (response.status !== 'pending') throw new HttpError(400, `This response is already ${response.status}`);
    const { action } = ctx.body;
    if (!['accept', 'decline'].includes(action)) throw new HttpError(400, 'action must be accept or decline');

    const respondingProfile = db.prepare('SELECT user_id FROM musician_profiles WHERE id = ?').get(response.musician_profile_id);

    if (action === 'decline') {
      db.prepare("UPDATE job_responses SET status='declined' WHERE id=?").run(response.id);
      if (respondingProfile) notify(respondingProfile.user_id, `Your response to "${job.title}" was declined.`, 'job');
      return { response: serializeJobResponse(db.prepare('SELECT * FROM job_responses WHERE id = ?').get(response.id)) };
    }

    db.prepare("UPDATE job_responses SET status='accepted' WHERE id=?").run(response.id);
    db.prepare("UPDATE job_postings SET status='filled', updated_at=datetime('now') WHERE id=?").run(job.id);
    if (respondingProfile) notify(respondingProfile.user_id, `You were accepted for "${job.title}"! Coordinate details with the poster on Musician Connect.`, 'job');

    const others = db.prepare("SELECT * FROM job_responses WHERE job_posting_id = ? AND status = 'pending' AND id != ?").all(job.id, response.id);
    others.forEach((r) => {
      db.prepare("UPDATE job_responses SET status='declined' WHERE id=?").run(r.id);
      const mp = db.prepare('SELECT user_id FROM musician_profiles WHERE id = ?').get(r.musician_profile_id);
      if (mp) notify(mp.user_id, `"${job.title}" was filled by another applicant.`, 'job');
    });

    return { response: serializeJobResponse(db.prepare('SELECT * FROM job_responses WHERE id = ?').get(response.id)) };
  });
}

module.exports = { register };
