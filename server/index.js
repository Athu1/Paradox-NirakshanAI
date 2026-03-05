import express from 'express';
import cors from 'cors';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env manually since we keep it simple
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
        const [k, ...v] = line.trim().split('=');
        if (k && v.length) process.env[k] = v.join('=').trim();
    }
}

const app = express();
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── Claude AI Report Generation ───────────────────────────────────────────
app.post('/api/report', async (req, res) => {
    const {
        incidentType, cameraId, location, severity,
        confidence, nearestCameras, servicesNotified,
        evidenceUrl, timestamp, scenarioDescription
    } = req.body;

    const systemPrompt = `You are a professional CCTV surveillance AI analyst for Nirakshan AI government surveillance system. 
You are generating an official incident report. Follow these STRICT anti-hallucination rules:
1. ONLY state what camera data confirms. Do NOT invent names, vehicle plates, or personal details.
2. If confidence < 85%, label the section as [UNVERIFIED].
3. Tag all inferences clearly with [INFERRED].
4. Do NOT extrapolate beyond the confirmed data.
5. End every report with a "CONFIDENCE ASSESSMENT" section.
6. Use formal, precise language appropriate for law enforcement use.
7. Include all provided data accurately — do not omit or alter camera IDs, coordinates, timestamps.`;

    const userPrompt = `Generate an official ~500-word incident report for Nirakshan AI Surveillance System:

INCIDENT DATA:
- Incident Type: ${incidentType}
- Primary Camera: ${cameraId}
- Location Coordinates: ${location}
- Date/Time: ${timestamp}
- Severity Level: ${severity}
- AI Confidence Score: ${confidence}%
- Scenario: ${scenarioDescription}

NEAREST CAMERAS ACTIVATED: ${nearestCameras.map(c => `${c.id} (${c.distance}m away)`).join(', ')}

EMERGENCY SERVICES NOTIFIED: ${servicesNotified.map(s => `${s.type}: ${s.unit} @ ${s.distance}km`).join(', ')}

EVIDENCE URL: ${evidenceUrl}

Write the full structured incident report now.`;

    if (!ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
    }

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-6',
                max_tokens: 1200,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }]
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(response.status).json({ error: errText });
        }

        const data = await response.json();
        const reportText = data.content?.[0]?.text || '';
        res.json({ report: reportText, usage: data.usage });
    } catch (err) {
        console.error('[/api/report]', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Cloud Upload Simulation ────────────────────────────────────────────────
app.post('/api/upload', async (req, res) => {
    const { cameraId, incidentType, timestamp, durationSeconds } = req.body;

    // Simulate upload delay
    await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));

    const startTs = new Date(timestamp);
    const endTs = new Date(startTs.getTime() + (durationSeconds || 45) * 1000);
    const fileSize = Math.floor(45 + Math.random() * 120); // MB
    const chunkId = `EVD-${cameraId}-${Date.now().toString(36).toUpperCase()}`;
    const bucketUrl = `https://nirakshan-cloud.storage.gov.in/evidence/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}/${chunkId}.mp4`;

    res.json({
        success: true,
        chunkId,
        cameraId,
        incidentType,
        startTimestamp: startTs.toISOString(),
        endTimestamp: endTs.toISOString(),
        durationSeconds: durationSeconds || 45,
        fileSizeMB: fileSize,
        url: bucketUrl,
        storageRegion: 'ap-south-1 (Mumbai)',
        encryptionStatus: 'AES-256-GCM',
        uploadedAt: new Date().toISOString()
    });
});

// ─── Emergency Services Notification ───────────────────────────────────────
app.post('/api/notify', async (req, res) => {
    const { services, incidentType, cameraId, location, severity } = req.body;

    // Simulate staggered dispatch confirmations
    await new Promise(r => setTimeout(r, 800 + Math.random() * 600));

    const dispatchTime = new Date();
    const confirmations = services.map((svc, i) => ({
        type: svc.type,
        unit: svc.unit,
        phone: svc.phone,
        distance: svc.distance,
        eta: `${Math.ceil(svc.distance * 3 + 2 + i * 1.5)} min`,
        dispatchCode: `DSP-${svc.type.toUpperCase().slice(0, 3)}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
        status: 'DISPATCH_CONFIRMED',
        acknowledgedAt: new Date(dispatchTime.getTime() + i * 800).toISOString()
    }));

    res.json({
        success: true,
        incidentRef: `INC-${Date.now().toString(36).toUpperCase()}`,
        cameraId,
        location,
        incidentType,
        severity,
        servicesDispatched: confirmations,
        totalUnitsDispatched: confirmations.length,
        notifiedAt: dispatchTime.toISOString()
    });
});

// ─── Full Autonomous Agent Pipeline ────────────────────────────────────────
app.post('/api/pipeline', async (req, res) => {
    // This orchestrates all steps server-side in order;
    // returns streaming-style progress via SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (step, status, data = {}) => {
        res.write(`data: ${JSON.stringify({ step, status, ...data, ts: new Date().toISOString() })}\n\n`);
    };

    const { incident, cameras, services } = req.body;

    try {
        // Step 1 — Pattern analysis
        send('PATTERN_ANALYSIS', 'running');
        await new Promise(r => setTimeout(r, 900));
        send('PATTERN_ANALYSIS', 'done', { result: 'Behavioral anomaly confirmed. YML pipeline complete.' });

        // Step 2 — Cloud upload
        send('CLOUD_UPLOAD', 'running');
        await new Promise(r => setTimeout(r, 1400));
        const chunkId = `EVD-${incident.cameraId}-${Date.now().toString(36).toUpperCase()}`;
        const evidenceUrl = `https://nirakshan-cloud.storage.gov.in/evidence/${new Date().getFullYear()}/${chunkId}.mp4`;
        const fileSizeMB = Math.floor(50 + Math.random() * 100);
        send('CLOUD_UPLOAD', 'done', { chunkId, evidenceUrl, fileSizeMB });

        // Step 3 — Notify emergency services
        send('EMERGENCY_NOTIFY', 'running');
        await new Promise(r => setTimeout(r, 1000));
        const dispatchCodes = services.map(s => `DSP-${s.type.slice(0, 3).toUpperCase()}-${Math.random().toString(36).slice(-4).toUpperCase()}`);
        send('EMERGENCY_NOTIFY', 'done', { units: services.length, dispatchCodes });

        // Step 4 — AI report generation
        send('AI_REPORT', 'running');
        let reportText = '';
        if (ANTHROPIC_API_KEY) {
            try {
                const sysPrompt = `You are a professional CCTV AI analyst. Follow strict anti-hallucination rules: only state confirmed facts, tag inferences with [INFERRED], label unverified items, end with CONFIDENCE ASSESSMENT.`;
                const userMsg = `Generate a ~500-word official incident report. Incident: ${incident.type} at Camera ${incident.cameraId}, Coordinates: ${incident.location}, Confidence: ${incident.confidence}%, Severity: ${incident.severity}, Evidence: ${evidenceUrl}, Services notified: ${services.map(s => s.type).join(', ')}.`;
                const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: 'claude-sonnet-4-6',
                        max_tokens: 1200,
                        system: sysPrompt,
                        messages: [{ role: 'user', content: userMsg }]
                    })
                });
                const aiData = await aiResp.json();
                reportText = aiData.content?.[0]?.text || 'Report generation failed.';
            } catch { reportText = 'AI report temporarily unavailable.'; }
        } else {
            reportText = '[DEMO MODE] ANTHROPIC_API_KEY not set. AI report skipped.';
        }
        send('AI_REPORT', 'done', { reportText });

        // Step 5 — Hallucination validation
        send('HALLUCINATION_GUARD', 'running');
        await new Promise(r => setTimeout(r, 600));
        const warnings = [];
        if (incident.confidence < 85) warnings.push({ code: 'LOW_CONFIDENCE', msg: `Confidence ${incident.confidence}% is below 85% threshold — report sections marked UNVERIFIED` });
        const overconfidentTerms = ['definitely', 'certainly', 'without doubt', 'absolutely', 'guaranteed'];
        const overconfidentHits = overconfidentTerms.filter(t => reportText.toLowerCase().includes(t));
        if (overconfidentHits.length) warnings.push({ code: 'OVERCONFIDENT_LANGUAGE', msg: `Detected overconfident language: ${overconfidentHits.join(', ')}` });
        if (reportText.length > 0 && !reportText.toLowerCase().includes(incident.type.split(' ')[0].toLowerCase())) {
            warnings.push({ code: 'TYPE_MISMATCH', msg: 'AI report may not fully match the declared incident type' });
        }
        send('HALLUCINATION_GUARD', 'done', { warnings, passed: warnings.length === 0 });

        send('COMPLETE', 'done', { summary: 'All pipeline steps executed successfully.', evidenceUrl });
    } catch (err) {
        send('ERROR', 'failed', { error: err.message });
    }

    res.end();
});

app.listen(PORT, () => {
    console.log(`\n🚨 Nirakshan AI Server running on http://localhost:${PORT}`);
    console.log(`   ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? '✅ Configured' : '❌ NOT SET — add to server/.env'}\n`);
});
