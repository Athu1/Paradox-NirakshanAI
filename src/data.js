// ─── Camera Locations (starts empty — add via the Cameras tab) ─────────────────
export const CAMERAS = [];

// ─── Emergency Services ─────────────────────────────────────────────────────
export const EMERGENCY_SERVICES = [
    { id: 'POL-1', type: 'Police', unit: 'Shivajinagar PS Unit 1', phone: '020-25531800', emoji: '🚔', lat: 18.5300, lon: 73.8450 },
    { id: 'POL-2', type: 'Police', unit: 'Koregaon Park PS', phone: '020-26153333', emoji: '🚔', lat: 18.5360, lon: 73.8940 },
    { id: 'POL-3', type: 'Police', unit: 'Hinjewadi PS', phone: '020-22943401', emoji: '🚔', lat: 18.5900, lon: 73.7400 },
    { id: 'FIRE-1', type: 'Fire', unit: 'Central Fire Station', phone: '101', emoji: '🚒', lat: 18.5195, lon: 73.8553 },
    { id: 'FIRE-2', type: 'Fire', unit: 'Katraj Fire Post', phone: '020-24372101', emoji: '🚒', lat: 18.4600, lon: 73.8650 },
    { id: 'HOSP-1', type: 'Hospital', unit: 'Sassoon General Hosp.', phone: '020-26128000', emoji: '🚑', lat: 18.5196, lon: 73.8553 },
    { id: 'HOSP-2', type: 'Hospital', unit: 'Ruby Hall Clinic', phone: '020-66455000', emoji: '🚑', lat: 18.5342, lon: 73.8895 },
    { id: 'HOSP-3', type: 'Hospital', unit: 'Deenanath Mangeshkar', phone: '020-49150700', emoji: '🚑', lat: 18.5063, lon: 73.8240 },
];

// ─── Incident Scenarios ─────────────────────────────────────────────────────
export const SCENARIOS = [
    {
        id: 'SC-001',
        type: 'Physical Fight',
        emoji: '⚔️',
        severity: 'CRITICAL',
        confidence: 93,
        description: 'Two individuals engaged in violent altercation. Bystanders dispersing. Possible weapon visible.',
        requiredServices: ['Police'],
        colorClass: 'critical',
    },
    {
        id: 'SC-002',
        type: 'ATM Loitering',
        emoji: '🏧',
        severity: 'SUSPICIOUS',
        confidence: 78,
        description: 'Individual loitering near ATM vestibule for >20 minutes. Erratic body language detected.',
        requiredServices: ['Police'],
        colorClass: 'suspicious',
    },
    {
        id: 'SC-003',
        type: 'Abandoned Bag',
        emoji: '🎒',
        severity: 'CRITICAL',
        confidence: 89,
        description: 'Unattended baggage detected in high-footfall area for >15 minutes. No owner identified.',
        requiredServices: ['Police', 'Fire'],
        colorClass: 'critical',
    },
    {
        id: 'SC-004',
        type: 'Crowd Surge',
        emoji: '👥',
        severity: 'SUSPICIOUS',
        confidence: 82,
        description: 'Rapid crowd density increase detected. Stampede risk threshold approaching critical zone.',
        requiredServices: ['Police', 'Hospital'],
        colorClass: 'suspicious',
    },
    {
        id: 'SC-005',
        type: 'Vehicle Intrusion',
        emoji: '🚗',
        severity: 'CRITICAL',
        confidence: 96,
        description: 'Unauthorized vehicle has entered pedestrian-only zone at high speed. Collision risk elevated.',
        requiredServices: ['Police', 'Fire', 'Hospital'],
        colorClass: 'critical',
    },
];

export const CAMERA_STATUSES = ['CLEAR', 'CLEAR', 'CLEAR', 'SUSPICIOUS', 'CRITICAL', 'CLEAR'];

export const API_BASE = 'http://localhost:3001';

export const GOOGLE_MAPS_API_KEY = 'AIzaSyBo76tcZqaSv8KSTeoAUhEdtnTLW28HTtg';
