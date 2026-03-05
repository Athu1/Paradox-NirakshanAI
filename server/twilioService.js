/**
 * ─── Nirakshan AI — Twilio Alert Service ───────────────────────────────────
 * Provides two functions:
 *   sendSmsAlert(incident)     — sends an urgent SMS to the registered number
 *   triggerVoiceCall(incident) — initiates a TTS voice call with the incident
 *
 * Required environment variables in server/.env:
 *   TWILIO_ACCOUNT_SID   — your Twilio Account SID (starts with AC…)
 *   TWILIO_AUTH_TOKEN    — your Twilio Auth Token
 *   TWILIO_PHONE_NUMBER  — the Twilio number that sends SMS / calls (+E.164 format)
 *   ALERT_PHONE_NUMBER   — the recipient's phone number (+E.164 format)
 *   API_BASE_URL         — public URL of this server (needed for TwiML webhook)
 *                          e.g. https://your-ngrok-id.ngrok.io  or  http://localhost:3001
 */

import twilio from 'twilio';

const {
    TWILIO_ACCOUNT_SID = "AC84974a8ae55da06008398293504a97b7",
    TWILIO_AUTH_TOKEN = "42e4c86fda9d96915d48b4cbebae288a",
    TWILIO_PHONE_NUMBER = "+15156545431",
    ALERT_PHONE_NUMBER = "+919657785987",
    API_BASE_URL = "https://lactic-complicated-reese.ngrok-free.dev",
} = process.env;

function getClient() {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
        throw new Error('Twilio credentials not set in server/.env');
    }
    return twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/**
 * Send an urgent SMS to the alert phone number.
 * @param {{ id, type, cameraId, severity, confidence, description, lat, lon }} incident
 */
export async function sendSmsAlert(incident) {
    const client = getClient();
    // Keep SMS under 160 chars: severity + camera + coords + type
    const lat = incident.lat != null ? Number(incident.lat).toFixed(4) : '?';
    const lon = incident.lon != null ? Number(incident.lon).toFixed(4) : '?';
    const body = `[Nirakshan] ${incident.severity} | ${incident.cameraId} | ${lat},${lon} | ${incident.type} (${incident.confidence}%)`.slice(0, 160);

    const message = await client.messages.create({
        body,
        from: TWILIO_PHONE_NUMBER,
        to: ALERT_PHONE_NUMBER,
    }
    );

    console.log(`[Twilio SMS] ✅ Sent — SID: ${message.sid}`);
    return { sid: message.sid, status: message.status };
}

/**
 * Initiate an automated TTS voice call to the alert phone number.
 * The TwiML XML is served by the /api/twiml endpoint on this same server.
 * @param {{ id, type, cameraId, severity, confidence, description }} incident
 */
export async function triggerVoiceCall(incident) {
    const client = getClient();

    // Pass the incident data as URL-encoded query params so the TwiML webhook
    // can build a dynamic message without storing state.
    const params = new URLSearchParams({
        type: incident.type,
        cameraId: incident.cameraId,
        severity: incident.severity,
        confidence: String(incident.confidence ?? ''),
        desc: (incident.description ?? '').slice(0, 200),
    });

    const twimlUrl = `${API_BASE_URL || 'http://localhost:3001'}/api/twiml?${params}`;

    const call = await client.calls.create({
        url: twimlUrl,
        from: TWILIO_PHONE_NUMBER,
        to: ALERT_PHONE_NUMBER,
    });

    console.log(`[Twilio Call] ✅ Initiated — SID: ${call.sid}`);
    return { sid: call.sid, status: call.status };
}
