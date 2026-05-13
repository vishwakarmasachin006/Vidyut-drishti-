const storage = {
    users: 'vidyutUsers',
    activeUser: 'vidyutActiveUser',
    readings: 'vidyutReadings'
};

let activeUser = null;
let usageChart = null;
let lastImageFile = null;
let lastOcrCandidates = [];
let previousReadingTouched = false;
const apiBase = location.protocol.startsWith('http') ? location.origin : '';
const $ = id => document.getElementById(id);
const readStore = (key, fallback) => JSON.parse(localStorage.getItem(key) || fallback);
const saveStore = (key, value) => localStorage.setItem(key, JSON.stringify(value));

document.addEventListener('DOMContentLoaded', () => {
    const previousInput = $('prevReading');
    if (previousInput) {
        previousInput.addEventListener('input', () => {
            previousReadingTouched = true;
            const hint = $('previousHint');
            if (hint) hint.innerText = 'Previous reading manually set hai.';
        });
    }

    const savedEmail = localStorage.getItem(storage.activeUser);
    if (savedEmail) {
        const user = getUsers().find(item => item.email === savedEmail);
        if (user) openDashboard(user);
    }
    renderHistory();
});

function getUsers() {
    return readStore(storage.users, '[]');
}

function saveUsers(users) {
    saveStore(storage.users, users);
}

function getAllReadings() {
    return readStore(storage.readings, '{}');
}

function getUserReadings() {
    if (!activeUser) return [];
    return getAllReadings()[activeUser.email] || [];
}

function getLastReading() {
    const readings = getUserReadings();
    return readings.length ? readings[readings.length - 1] : null;
}

function suggestPreviousReading() {
    const previousInput = $('prevReading');
    const hint = $('previousHint');
    if (!previousInput || !activeUser) return;
    if (previousReadingTouched && previousInput.value !== '') return;

    const lastReading = getLastReading();
    if (lastReading) {
        previousInput.value = lastReading.current;
        if (hint) hint.innerText = `Auto-filled from last saved current reading: ${lastReading.current}`;
    } else {
        previousInput.value = '';
        if (hint) hint.innerText = 'First time: last bill ki old/previous reading likhein.';
    }
}

function saveUserReadings(readings) {
    const allReadings = getAllReadings();
    allReadings[activeUser.email] = readings;
    saveStore(storage.readings, allReadings);
}

function handleLogin(event) {
    event.preventDefault();

    const user = {
        name: $('userName').value.trim(),
        email: $('userEmail').value.trim().toLowerCase(),
        phone: $('userPhone').value.trim() || 'Not added',
        meter: $('meterNumber').value.trim(),
        address: $('userAddress').value.trim() || 'Not added'
    };

    const users = getUsers();
    const existingIndex = users.findIndex(item => item.email === user.email);
    if (existingIndex >= 0) users[existingIndex] = user;
    else users.push(user);
    saveUsers(users);
    syncUserToBackend(user);

    if ($('rememberUser').checked) {
        localStorage.setItem(storage.activeUser, user.email);
    }

    openDashboard(user);
}

function openDashboard(user) {
    activeUser = user;
    previousReadingTouched = false;
    $('displayUserName').innerText = user.name;
    $('displayMeter').innerText = user.meter;
    $('displayEmail').innerText = user.email;
    $('displayPhone').innerText = user.phone;
    $('loginSection').classList.add('hidden');
    $('mainAppSection').classList.remove('hidden');
    $('logoutBtn').classList.remove('hidden');
    renderHistory();
    suggestPreviousReading();
}

function logoutApp() {
    activeUser = null;
    localStorage.removeItem(storage.activeUser);
    $('loginSection').classList.remove('hidden');
    $('mainAppSection').classList.add('hidden');
    $('logoutBtn').classList.add('hidden');
    document.querySelector('form').reset();
    resetScan();
}

function previewImage(event) {
    const input = event.target;
    if (!input.files || !input.files[0]) return;

    lastImageFile = input.files[0];
    const reader = new FileReader();
    reader.onload = function(readerEvent) {
        $('imagePreview').src = readerEvent.target.result;
        $('imagePreview').classList.remove('hidden');
        $('uploadPlaceholder').classList.add('hidden');
        $('currentReading').value = '';
        lastOcrCandidates = [];
        $('ocrTextBox').innerText = 'Image ready. OCR chalane ke liye Read Meter by OCR dabayein.';
    };
    reader.readAsDataURL(lastImageFile);
}

function setCurrentReading(value) {
    const currentInput = $('currentReading');
    currentInput.value = value;
    currentInput.dispatchEvent(new Event('input', { bubbles: true }));
}

async function runOcrOnly() {
    if (!lastImageFile) {
        alert('Pehle meter photo upload karein.');
        return null;
    }

    showLoader(true, 'Preparing image for OCR...');
    const reading = await readMeterFromImage(lastImageFile);
    showLoader(false);

    if (reading !== null && reading > 0) {
        setCurrentReading(reading);
        return reading;
    }

    alert('OCR reading clear nahi mila. Current Reading box me meter reading manually type karein.');
    return null;
}

async function handleFormSubmit(event) {
    event.preventDefault();

    const prevReading = Number($('prevReading').value);
    const rate = Number($('unitRate').value);
    const currentReadingInput = $('currentReading').value;
    let currentReading = currentReadingInput !== '' ? Number(currentReadingInput) : null;

    if (currentReading === null && lastImageFile) {
        currentReading = await runOcrOnly();
    }

    if (currentReading === null || currentReading === 0) {
        alert('OCR reading clear nahi mila. Current Reading box me meter reading type karke phir calculate karein.');
        return;
    }

    const units = calculateUnits(prevReading, currentReading);
    const bill = units * rate;
    const record = {
        date: new Date().toLocaleDateString('en-IN'),
        previous: prevReading,
        current: currentReading,
        totalMeterUnits: currentReading,
        units,
        rate,
        bill: Number(bill.toFixed(2))
    };

    const readings = getUserReadings();
    readings.push(record);
    saveUserReadings(readings);
    saveReadingToBackend(record);
    
    const totalTrackedUnits = readings.reduce((sum, item) => sum + Number(item.units || 0), 0);
    
    showResult(record, totalTrackedUnits);
    $('ocrTextBox').innerText = 'Bill successfully calculated and saved!';
    
    renderHistory();
}

function calculateUnits(previousReading, currentReading) {
    return Math.abs(Number(currentReading) - Number(previousReading));
}

async function readMeterFromImage(file) {
    let worker = null;
    try {
        if (!window.Tesseract) {
            $('ocrTextBox').innerText = 'Tesseract OCR library could not load. Enter current reading manually.';
            return null;
        }

        const preparedImages = await prepareImagesForOcr(file);
        const allCandidates = [];
        let combinedText = '';
        const modes = [
            Tesseract.PSM?.SINGLE_LINE || '7',
            Tesseract.PSM?.SINGLE_BLOCK || '6',
            Tesseract.PSM?.SPARSE_TEXT || '11'
        ];

        worker = await Tesseract.createWorker('eng', 1, {
            logger: message => {
                if (message.status === 'recognizing text') {
                    const percent = message.progress ? ` ${Math.round(message.progress * 100)}%` : '';
                    showLoader(true, `Extracting reading...${percent}`);
                } else {
                    showLoader(true, `Initializing AI OCR...`);
                }
            }
        });
        
        await worker.setParameters({
            tessedit_char_whitelist: '0123456789.',
            preserve_interword_spaces: '1'
        });

        for (const image of preparedImages) {
            for (const psm of modes) {
                await worker.setParameters({ tessedit_pageseg_mode: psm });
                const result = await worker.recognize(image.source);
                const text = result.data.text || '';
                combinedText += `\n[${image.label} - PSM ${psm}]: ${text.trim()}`;

                const confidence = Number(result.data.confidence || 0);
                allCandidates.push(...extractReadingCandidates(text, image.label, psm, confidence));
            }
        }

        lastOcrCandidates = rankReadingCandidates(allCandidates);
        const bestReading = lastOcrCandidates.length ? lastOcrCandidates[0].value : null;
        renderOcrResult(bestReading, combinedText);

        return bestReading;
    } catch (error) {
        console.error("OCR Error:", error);
        $('ocrTextBox').innerText = 'OCR failed. Enter current reading manually.';
        return null;
    } finally {
        if (worker) await worker.terminate();
    }
}

function loadImageElement(file) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const objectUrl = URL.createObjectURL(file);
        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };
        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Image could not be loaded for OCR'));
        };
        image.src = objectUrl;
    });
}

async function prepareImagesForOcr(file) {
    const image = await loadImageElement(file);
    const targetWidth = 1800;
    const scale = Math.min(4, Math.max(1, targetWidth / image.width));
    const fullWidth = Math.round(image.width * scale);
    const fullHeight = Math.round(image.height * scale);
    const centerCrop = {
        x: image.width * 0.05,
        y: image.height * 0.15,
        width: image.width * 0.9,
        height: image.height * 0.7
    };
    const displayCrop = {
        x: image.width * 0.12,
        y: image.height * 0.25,
        width: image.width * 0.76,
        height: image.height * 0.45
    };

    return [
        { label: 'Display boosted', source: createOcrCanvas(image, null, null, 'boost', displayCrop) },
        { label: 'Display adaptive', source: createOcrCanvas(image, null, null, 'adaptive', displayCrop) },
        { label: 'Display high contrast', source: createOcrCanvas(image, null, null, 'threshold', displayCrop) },
        { label: 'Display inverted', source: createOcrCanvas(image, null, null, 'invertThreshold', displayCrop) },
        { label: 'Center boosted', source: createOcrCanvas(image, null, null, 'boost', centerCrop) },
        { label: 'Center adaptive', source: createOcrCanvas(image, null, null, 'adaptive', centerCrop) },
        { label: 'Center high contrast', source: createOcrCanvas(image, null, null, 'threshold', centerCrop) },
        { label: 'Full high contrast', source: createOcrCanvas(image, fullWidth, fullHeight, 'threshold') },
        { label: 'Full boosted', source: createOcrCanvas(image, fullWidth, fullHeight, 'boost') },
        { label: 'Original', source: file }
    ];
}

function createOcrCanvas(image, width, height, mode = 'boost', crop = null) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const sourceWidth = crop ? crop.width : image.width;
    const sourceHeight = crop ? crop.height : image.height;
    const scale = width ? width / sourceWidth : Math.min(4, Math.max(2, 1800 / sourceWidth));
    canvas.width = Math.round(width || sourceWidth * scale);
    canvas.height = Math.round(height || sourceHeight * scale);
    
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    
    if (crop) {
        context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
    } else {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
    }

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    let graySum = 0;
    const grayValues = new Uint8ClampedArray(data.length / 4);

    for (let index = 0; index < data.length; index += 4) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const gray = r * 0.299 + g * 0.587 + b * 0.114;
        grayValues[index / 4] = gray;
        graySum += gray;
    }

    const averageGray = graySum / grayValues.length;
    const threshold = Math.max(95, Math.min(175, averageGray * 0.92));

    for (let index = 0; index < data.length; index += 4) {
        const gray = grayValues[index / 4];
        const contrast = Math.max(0, Math.min(255, (gray - 128) * 2.8 + 128));
        let binarized = contrast;
        if (mode === 'threshold') {
            binarized = contrast > threshold ? 255 : 0;
        } else if (mode === 'invertThreshold') {
            binarized = contrast > threshold ? 0 : 255;
        } else if (mode === 'adaptive') {
            binarized = gray > threshold ? 255 : 0;
        }
        
        data[index] = binarized;
        data[index + 1] = binarized;
        data[index + 2] = binarized;
    }
    context.putImageData(imageData, 0, 0);
    return canvas;
}

function extractReadingCandidates(text, label = '', psm = '', confidence = 0) {
    const normalizedText = text
        .replace(/[Oo]/g, '0')
        .replace(/[Il|]/g, '1')
        .replace(/[S]/g, '5')
        .replace(/[B]/g, '8')
        .replace(/[Z]/g, '2')
        .replace(/[G]/g, '6')
        .replace(/[^\d.]/g, ' ');
    const compactDigits = normalizedText.replace(/\D/g, '');
    const rawCandidates = [
        ...(normalizedText.match(/\d+(?:\.\d+)?/g) || []),
        ...extractJoinedDigitGroups(normalizedText),
        ...splitLongDigitRuns(compactDigits)
    ];
    return rawCandidates
        .flatMap(rawValue => {
            const cleanValue = rawValue.replace(/^\.+|\.+$/g, '');
            const digits = cleanValue.replace(/\D/g, '');
            if (!digits) return [];

            let values = [];
            if (cleanValue.includes('.')) {
                const [integerPart, decimalPart = ''] = cleanValue.split('.');
                if (integerPart.length >= 3) {
                    values.push(Number(integerPart));
                } else if (digits.length >= 3) {
                    values.push(Number(digits));
                }

                if (decimalPart.length >= 3) {
                    values.push(Number(decimalPart));
                }
            } else {
                values.push(Number(digits));
            }

            if (digits.length > 5 && digits.startsWith('0')) values.push(Number(digits.replace(/^0+/, '')));

            return values.map(value => ({
                value: Math.round(value),
                digitLength: String(Math.round(value)).length,
                raw: rawValue,
                label,
                psm,
                confidence
            }));
        })
        .filter(item => Number.isFinite(item.value) && item.value >= 10 && item.value <= 9999999);
}

function extractJoinedDigitGroups(text) {
    const groups = text.match(/(?:\b\d{1,2}\b[\s.]+){2,}\b\d{1,2}\b/g) || [];
    return groups
        .map(group => group.replace(/\D/g, ''))
        .filter(value => value.length >= 3 && value.length <= 7);
}

function splitLongDigitRuns(digits) {
    if (!digits || digits.length < 3) return [];
    if (digits.length <= 7) return [digits];

    const values = [];
    for (let length = 7; length >= 4; length -= 1) {
        values.push(digits.slice(0, length), digits.slice(-length));
    }
    return values;
}

function rankReadingCandidates(candidates) {
    if (!candidates.length) return [];

    const prevReading = Number($('prevReading').value) || 0;
    const seenCounts = candidates.reduce((counts, item) => {
        counts[item.value] = (counts[item.value] || 0) + 1;
        return counts;
    }, {});
    const likelyCandidates = prevReading
        ? candidates.filter(item => Math.abs(item.value - prevReading) <= 50000)
        : candidates;

    const pool = likelyCandidates.length ? likelyCandidates : candidates;
    const bestByValue = pool.reduce((map, candidate) => {
        const score = scoreReadingCandidate(candidate, prevReading, seenCounts);
        const existing = map.get(candidate.value);
        if (!existing || score > existing.score) {
            map.set(candidate.value, { ...candidate, score, count: seenCounts[candidate.value] || 1 });
        }
        return map;
    }, new Map());

    return Array.from(bestByValue.values()).sort((a, b) => b.score - a.score).slice(0, 6);
}

function scoreReadingCandidate(candidate, prevReading, seenCounts = {}) {
    let score = 0;
    const value = candidate.value;
    const digitLength = candidate.digitLength;

    if (digitLength >= 4 && digitLength <= 7) score += 60;
    else if (digitLength === 3) score += 20;
    else score -= 35;

    if (prevReading) {
        const difference = Math.abs(value - prevReading);
        if (difference <= 20000) score += 45;
        if (difference <= 5000) score += 25;
        score -= Math.min(difference / 250, 80);
    } else {
        score += Math.min(value / 1000, 35);
    }

    if (candidate.label.includes('Display')) score += 18;
    if (candidate.label.includes('Center')) score += 8;
    if (String(candidate.psm) === '7') score += 8;
    score += Math.min((seenCounts[value] || 1) * 8, 40);
    score += Math.min(candidate.confidence || 0, 95) / 8;

    return score;
}

function renderOcrResult(bestReading, combinedText) {
    const topCandidates = lastOcrCandidates.slice(0, 5);
    const buttons = topCandidates.map(candidate => `
        <button type="button" onclick="setCurrentReading(${candidate.value})" class="mr-2 mt-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-700 hover:border-brand hover:bg-white">
            ${candidate.value}
        </button>
    `).join('');

    $('ocrTextBox').innerHTML = `
        <div class="font-black text-slate-700">Detected reading: ${bestReading || 'not clear'}</div>
        <div class="mt-1 text-xs text-slate-500">Agar reading wrong ho to neeche candidate par click karein ya current reading manually type karein.</div>
        <div>${buttons || '<span class="mt-2 block text-xs text-red-500">No readable number found.</span>'}</div>
        <pre class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-xs text-slate-500">${escapeHtml(combinedText.trim() || 'No text found by OCR.')}</pre>
    `;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showLoader(visible, statusText = 'OCR running') {
    $('ocrStatus').innerText = statusText;
    $('loader').classList.toggle('hidden', !visible);
}

function showResult(record, totalTrackedUnits) {
    $('resReading').innerText = record.current;
    $('resTotalMeter').innerText = totalTrackedUnits !== undefined ? totalTrackedUnits : record.current;
    $('resUnits').innerText = record.units;
    $('resBill').innerText = record.bill.toFixed(2);
    $('resultSection').classList.remove('hidden');
}

function resetScan() {
    const form = $('meterForm');
    const previousInput = $('prevReading');
    const rateInput = $('unitRate');
    const previousValue = previousInput ? previousInput.value : '';
    const rateValue = rateInput ? rateInput.value : '';
    if (form) form.reset();
    if (previousInput) previousInput.value = previousValue;
    if (rateInput) rateInput.value = rateValue;
    lastImageFile = null;
    $('imagePreview').classList.add('hidden');
    $('uploadPlaceholder').classList.remove('hidden');
    $('resultSection').classList.add('hidden');
    $('ocrTextBox').innerText = 'OCR text will appear here after scan.';
    showLoader(false);
    if (!previousValue) suggestPreviousReading();
}

function renderHistory() {
    const table = $('historyTable');
    if (!table) return;

    const readings = getUserReadings();
    table.innerHTML = readings.length
        ? readings.slice().reverse().map((item, index) => `
            <tr class="animate-rise" style="animation-delay: ${index * 0.05}s">
                <td class="py-3 font-semibold">${item.date}</td>
                <td class="py-3">${item.previous}</td>
                <td class="py-3">${item.current}</td>
                <td class="py-3 font-bold text-solar">${item.units}</td>
                <td class="py-3">Rs. ${Number(item.rate).toFixed(2)}</td>
                <td class="py-3 font-black text-red-600">Rs. ${Number(item.bill).toFixed(2)}</td>
            </tr>
        `).join('')
        : `<tr><td colspan="6" class="py-8 text-center text-slate-500">No readings saved yet.</td></tr>`;

    renderChart(readings);
    renderSummary(readings);
}

function renderSummary(readings) {
    const totalUnits = readings.reduce((sum, item) => sum + Number(item.units || 0), 0);
    const averageUnits = readings.length ? totalUnits / readings.length : 0;
    const latestBill = readings.length ? Number(readings[readings.length - 1].bill || 0) : 0;

    $('summaryTotalUnits').innerText = totalUnits.toFixed(0);
    $('summaryAverageUnits').innerText = averageUnits.toFixed(1);
    $('summaryLatestBill').innerText = latestBill.toFixed(2);
}

function renderChart(readings) {
    const canvas = $('usageChart');
    const emptyState = $('chartEmptyState');
    if (emptyState) {
        emptyState.classList.toggle('hidden', readings.length > 0 && Boolean(window.Chart));
        if (readings.length > 0 && !window.Chart) {
            emptyState.innerText = 'Chart.js load nahi hua. Internet/CDN check karein.';
        } else if (!readings.length) {
            emptyState.innerText = 'Calculation save karte hi graph yahan dikhega.';
        }
    }
    if (!readings.length && usageChart) {
        usageChart.destroy();
        usageChart = null;
    }
    if (!canvas || !window.Chart) return;

    if (usageChart) usageChart.destroy();
    const context = canvas.getContext('2d');
    const unitsGradient = context.createLinearGradient(0, 0, 0, canvas.height || 320);
    unitsGradient.addColorStop(0, 'rgba(16, 185, 129, 0.72)');
    unitsGradient.addColorStop(1, 'rgba(16, 185, 129, 0.14)');

    usageChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: readings.map((item, index) => item.date || `Bill ${index + 1}`),
            datasets: [
                {
                    type: 'bar',
                    label: 'Bill Units',
                    data: readings.map(item => item.units),
                    borderColor: '#10b981',
                    backgroundColor: unitsGradient,
                    borderRadius: 10,
                    borderWidth: 1,
                    yAxisID: 'y'
                },
                {
                    type: 'line',
                    label: 'Bill Rs.',
                    data: readings.map(item => item.bill),
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.14)',
                    tension: 0.38,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    borderWidth: 3,
                    yAxisID: 'y1'
                },
                {
                    type: 'line',
                    label: 'Meter Reading',
                    data: readings.map(item => item.totalMeterUnits ?? item.current),
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.12)',
                    tension: 0.28,
                    pointRadius: 3,
                    borderDash: [6, 5],
                    yAxisID: 'y2'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        boxWidth: 8,
                        padding: 18,
                        font: { weight: 'bold' }
                    }
                },
                tooltip: {
                    backgroundColor: '#172033',
                    padding: 12,
                    cornerRadius: 10,
                    titleFont: { weight: 'bold' },
                    callbacks: {
                        label: context => {
                            const value = Number(context.raw || 0);
                            if (context.dataset.label === 'Bill Rs.') return ` Bill: Rs. ${value.toFixed(2)}`;
                            return ` ${context.dataset.label}: ${value}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { weight: 'bold' } }
                },
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Bill Units' },
                    grid: { color: 'rgba(148, 163, 184, 0.18)' }
                },
                y1: {
                    beginAtZero: true,
                    position: 'right',
                    title: { display: true, text: 'Bill Rs.' },
                    grid: { drawOnChartArea: false }
                },
                y2: {
                    beginAtZero: true,
                    display: false,
                    position: 'right',
                    grid: { drawOnChartArea: false }
                }
            }
        }
    });
}

function clearHistory() {
    if (!activeUser) return;
    if (!confirm('Clear all saved readings for this user?')) return;
    saveUserReadings([]);
    clearBackendHistory();
    renderHistory();
    $('resultSection').classList.add('hidden');
}

function exportHistory() {
    const readings = getUserReadings();
    if (!readings.length) {
        alert('No history available to export.');
        return;
    }

    const header = 'Date,Previous,Current,Units,Rate,Bill\n';
    const rows = readings.map(item => `${item.date},${item.previous},${item.current},${item.units},${item.rate},${item.bill}`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'vidyut-drishti-history.csv';
    link.click();
    URL.revokeObjectURL(link.href);
}

function toggleTheme() {
    document.body.classList.toggle('brightness-95');
    document.body.classList.toggle('contrast-125');
}

async function loadAdminData() {
    if (!apiBase) {
        alert('Admin data dekhne ke liye app ko server se run karein.');
        return;
    }

    const pin = prompt('Admin PIN enter karein');
    if (!pin) return;

    try {
        const response = await fetch(`${apiBase}/api/admin-data?pin=${encodeURIComponent(pin)}`);
        if (!response.ok) throw new Error('Admin data load nahi hua.');
        renderAdminData(await response.json());
    } catch (error) {
        alert(error.message || 'Admin data load nahi hua.');
    }
}

function renderAdminData(data) {
    const users = data.users || [];
    const readings = data.readings || {};
    const rows = users.map(user => {
        const userReadings = readings[user.email] || [];
        const last = userReadings[userReadings.length - 1] || {};
        return `
            <tr class="border-b border-slate-100">
                <td class="py-3 font-bold">${escapeHtml(user.name)}</td>
                <td class="py-3">${escapeHtml(user.email)}</td>
                <td class="py-3">${escapeHtml(user.phone || '-')}</td>
                <td class="py-3">${escapeHtml(user.meter || '-')}</td>
                <td class="py-3">${userReadings.length}</td>
                <td class="py-3">${last.current || '-'}</td>
                <td class="py-3">Rs. ${Number(last.bill || 0).toFixed(2)}</td>
            </tr>
        `;
    }).join('');

    $('adminDataBox').innerHTML = `
        <table class="w-full min-w-[760px] text-left">
            <thead class="text-slate-500">
                <tr class="border-b border-slate-200">
                    <th class="py-3">Name</th>
                    <th class="py-3">Email</th>
                    <th class="py-3">Phone</th>
                    <th class="py-3">Meter</th>
                    <th class="py-3">Bills</th>
                    <th class="py-3">Last Reading</th>
                    <th class="py-3">Last Bill</th>
                </tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="7" class="py-6 text-center">No backend data saved yet.</td></tr>'}</tbody>
        </table>
    `;
    $('adminSection').classList.remove('hidden');
    $('adminSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function postJson(path, data) {
    if (!apiBase) return;
    return fetch(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
}

async function syncUserToBackend(user) {
    try {
        await postJson('/api/users', user);
    } catch {
        console.log('Backend user sync skipped.');
    }
}

async function saveReadingToBackend(record) {
    if (!activeUser) return;

    try {
        await postJson('/api/readings', { email: activeUser.email, record });
    } catch {
        console.log('Backend reading sync skipped.');
    }
}

async function clearBackendHistory() {
    if (!apiBase || !activeUser) return;

    try {
        await fetch(`${apiBase}/api/readings?email=${encodeURIComponent(activeUser.email)}`, {
            method: 'DELETE'
        });
    } catch {
        console.log('Backend clear skipped.');
    }
}
