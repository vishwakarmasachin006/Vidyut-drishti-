const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'vidyut-data.json');
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const emptyDb = { users: [], readings: {} };
const jsonHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};
const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8'
};

const send = (res, code, data) => {
    res.writeHead(code, jsonHeaders);
    res.end(JSON.stringify(data));
};

const cleanEmail = value => String(value || '').trim().toLowerCase();
const safeDb = data => ({
    users: Array.isArray(data.users) ? data.users : [],
    readings: data.readings && typeof data.readings === 'object' ? data.readings : {}
});

function db(nextData) {
    if (nextData) fs.writeFileSync(DATA_FILE, JSON.stringify(safeDb(nextData), null, 2));
    try {
        if (!fs.existsSync(DATA_FILE)) db(emptyDb);
        return safeDb(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8') || '{}'));
    } catch (error) {
        console.error('Database error:', error.message);
        return { ...emptyDb };
    }
}

function body(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => {
            raw += chunk;
            if (raw.length > 1_000_000) reject(new Error('Request body too large'));
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function userFrom(data) {
    return ['name', 'email', 'phone', 'meter', 'address'].reduce((user, key) => {
        user[key] = key === 'email' ? cleanEmail(data[key]) : String(data[key] || '').trim();
        return user;
    }, {});
}

function readingFrom(data) {
    const reading = {
        date: String(data.date || new Date().toLocaleDateString('en-IN')),
        previous: Number(data.previous),
        current: Number(data.current),
        totalMeterUnits: Number(data.totalMeterUnits ?? data.current),
        units: Number(data.units),
        rate: Number(data.rate),
        bill: Number(data.bill)
    };
    return Object.values(reading).slice(1).every(Number.isFinite) ? reading : null;
}

async function api(req, res, url) {
    if (req.method === 'OPTIONS') return send(res, 204, {});

    if (url.pathname === '/api/users' && req.method === 'GET') {
        return send(res, 200, { users: db().users });
    }

    if (url.pathname === '/api/users' && req.method === 'POST') {
        const data = db();
        const user = userFrom(await body(req));
        if (!user.name || !user.email) return send(res, 400, { error: 'Name and email are required.' });

        const index = data.users.findIndex(item => item.email === user.email);
        index >= 0 ? data.users[index] = user : data.users.push(user);
        db(data);
        return send(res, 200, { success: true, user });
    }

    if (url.pathname === '/api/readings' && req.method === 'GET') {
        const email = cleanEmail(url.searchParams.get('email'));
        const readings = db().readings;
        return send(res, 200, email ? { readings: readings[email] || [] } : { readings });
    }

    if (url.pathname === '/api/readings' && req.method === 'POST') {
        const data = db();
        const input = await body(req);
        const email = cleanEmail(input.email);
        const record = readingFrom(input.record || {});
        if (!email) return send(res, 400, { error: 'Email is required.' });
        if (!record) return send(res, 400, { error: 'Reading data is incomplete or invalid.' });

        data.readings[email] = [...(data.readings[email] || []), record];
        db(data);
        return send(res, 200, { success: true, record });
    }

    if (url.pathname === '/api/readings' && req.method === 'DELETE') {
        const email = cleanEmail(url.searchParams.get('email'));
        if (!email) return send(res, 400, { error: 'Email is required.' });
        const data = db();
        data.readings[email] = [];
        db(data);
        return send(res, 200, { success: true });
    }

    if (url.pathname === '/api/admin-data' && req.method === 'GET') {
        return url.searchParams.get('pin') === ADMIN_PIN
            ? send(res, 200, db())
            : send(res, 401, { error: 'Invalid admin PIN.' });
    }

    send(res, 404, { error: 'API route not found.' });
}

function file(req, res, url) {
    const name = url.pathname === '/' ? '/project6.html' : decodeURIComponent(url.pathname);
    const filePath = path.normalize(path.join(__dirname, name));
    if (!filePath.startsWith(__dirname)) return res.end('Forbidden');

    fs.readFile(filePath, (error, data) => {
        if (error) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('File not found');
        }
        res.writeHead(200, {
            'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
}

http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    url.pathname.startsWith('/api/')
        ? api(req, res, url).catch(error => send(res, 400, { error: error.message }))
        : file(req, res, url);
}).listen(PORT, () => console.log(`Vidyut server: http://localhost:${PORT}`));
