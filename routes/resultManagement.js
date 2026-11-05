const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const axios = require('axios');

// ============================================================================
// ⚙️ 1. API CONFIGURATION ZONE (সহজে পরিবর্তন করার জন্য সব API এক জায়গায়)
// ============================================================================

// 📱 BulkSMSBD API (SMS Gateway)
const SMS_API_URL = "http://bulksmsbd.net/api/smsapi";
const SMS_API_KEY = "FUBaGwWKKFxNLhCQfQp9";
const SMS_SENDER_ID = "8809617643475";

// 📧 OneSignal Email API (ইমেইল নোটিফিকেশনের জন্য)
const ONESIGNAL_APP_ID = "3e79ee6e-d2e0-4cd8-86b2-71a36fc1a8c8";
const ONESIGNAL_REST_API_KEY = "os_v2_app_hz4643ws4bgnrbvsogrw7qnizdighrdjhcauv5f35evsx6adeduispkwriuiohoifknp44tr7vh6wtnampn5mdpw5girrqcbhhmtdgq";

// 🛡️ Security & Project Config
const FIREBASE_PROJECT_ID = "srms-website-management";
const SRMS_ADMIN_PASSKEY = "SRMS_SUPER_ADMIN_OVERRIDE";


// ============================================================================
// 🛡️ 2. SECURITY & AUTHENTICATION HELPERS
// ============================================================================

function decodeJwtPayload(idToken) {
    if (!idToken || typeof idToken !== "string") return null;
    try {
        const parts = idToken.split('.');
        if (parts.length !== 3) return null;
        const payload = Buffer.from(parts[1], 'base64').toString('utf8');
        return JSON.parse(payload);
    } catch (e) {
        return null;
    }
}

async function verifyAdminAccess(idToken, adminKey) {
    if (adminKey === SRMS_ADMIN_PASSKEY) return true;
    if (!idToken) return false;
    try {
        const jwt = decodeJwtPayload(idToken);
        if (jwt) {
            const email = (jwt.email || "").toLowerCase();
            if (
                email === "admin@srms.edu.bd" ||
                email === "srms2012.edu@gmail.com" ||
                email.endsWith("@srms.edu.bd") ||
                jwt.aud === FIREBASE_PROJECT_ID ||
                (jwt.iss && jwt.iss.indexOf(FIREBASE_PROJECT_ID) !== -1)
            ) {
                return true;
            }
        }
        const decoded = await admin.auth().verifyIdToken(idToken);
        if (decoded && decoded.uid) return true;
    } catch (e) {}
    return false;
}


// ============================================================================
// 🛠️ 3. CORE HELPER FUNCTIONS (BulkSMSBD, OneSignal Email & Firestore Batch)
// ============================================================================

// --- 📱 BulkSMSBD SMS Sender ---
async function sendSMS(phoneNum, smsBody) {
    if (!phoneNum || phoneNum.toString().trim() === "") return null;
    try {
        let phone = phoneNum.toString().replace(/[^0-9]/g, "");
        if (phone.length < 10) return null;
        if (phone.length === 10) phone = "880" + phone;
        else if (phone.length === 11 && phone.startsWith("0")) phone = "88" + phone;
        else if (phone.startsWith("+88")) phone = phone.substring(1);

        const response = await axios.get(SMS_API_URL, {
            params: {
                api_key: SMS_API_KEY,
                type: "text",
                number: phone,
                senderid: SMS_SENDER_ID,
                message: smsBody
            },
            timeout: 10000
        });
        console.log(`💬 [Result] BulkSMSBD Response for ${phone}:`, response.data);
        return response.data;
    } catch (error) {
        console.error(`❌ [Result] BulkSMSBD Error for ${phoneNum}:`, error.message);
        return null;
    }
}

// --- 📧 OneSignal Email Sender ---
async function sendEmailNotification(emailAdd, emailSubject, emailHTML, fallbackText) {
    if (!emailAdd || emailAdd.toString().trim() === "" || !emailAdd.toString().includes("@")) return;
    const cleanEmail = emailAdd.toString().trim().toLowerCase();
    const finalHtml = emailHTML || `<p>${(fallbackText || "").replace(/\n/g, '<br>')}</p>`;

    try {
        try {
            await axios.post('https://onesignal.com/api/v1/players', {
                app_id: ONESIGNAL_APP_ID,
                device_type: 11, // 11 = Email
                identifier: cleanEmail
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 8000
            });
        } catch (regErr) {}

        await axios.post('https://api.onesignal.com/notifications', {
            app_id: ONESIGNAL_APP_ID,
            target_channel: "email",
            include_email_tokens: [cleanEmail],
            email_subject: emailSubject || "SRMS Result Published",
            email_body: finalHtml,
            email_from_name: "Saidpur Residential Model School (SRMS)"
        }, {
            headers: {
                'Authorization': `Key ${ONESIGNAL_REST_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
    } catch (error) {
        console.error(`❌ [Result] OneSignal Email Error for ${cleanEmail}:`, error.message);
    }
}

// --- ⚡ Firestore Chunked Batch Committer (৫০০+ স্টুডেন্ট হলেও ক্র্যাশ করবে না) ---
async function commitBatchOperations(db, operations) {
    if (!operations || operations.length === 0) return;
    const chunkSize = 450;
    for (let i = 0; i < operations.length; i += chunkSize) {
        const chunk = operations.slice(i, i + chunkSize);
        const batch = db.batch();
        chunk.forEach(op => {
            if (op.type === 'update') batch.update(op.ref, op.data);
            else if (op.type === 'set') batch.set(op.ref, op.data, op.options || { merge: true });
            else if (op.type === 'delete') batch.delete(op.ref);
        });
        await batch.commit();
    }
}


// ============================================================================
// 📊 4. RESULT CALCULATION, MIGRATION & ARCHIVE HELPERS
// ============================================================================

function getGP(p) {
    if (p >= 80) return 5.00;
    if (p >= 70) return 4.00;
    if (p >= 60) return 3.50;
    if (p >= 50) return 3.00;
    if (p >= 40) return 2.00;
    if (p >= 33) return 1.00;
    return 0.00;
}

function getGrade(g) {
    if (g >= 5.00) return "A+";
    if (g >= 4.00) return "A";
    if (g >= 3.50) return "A-";
    if (g >= 3.00) return "B";
    if (g >= 2.00) return "C";
    if (g >= 1.00) return "D";
    return "F";
}

function parsePartsFromHeader(h) {
    let match = h.match(/\(([^)]+)\)/);
    if (!match) return [{ name: "Total", max: 100 }];
    let raw = match[1].trim();
    if (!raw.includes(":")) return [{ name: "Total", max: parseInt(raw) || 100 }];
    let parts = raw.split('+');
    return parts.map(p => {
        let sp = p.split(':');
        return { name: sp[0].trim(), max: parseFloat(sp[1]) || 0 };
    });
}

function parseClassAndGroup(cls) {
    let rawCls = (cls || "").toString().trim();
    let searchGroup = "";
    if (rawCls.toLowerCase().includes("science")) { searchGroup = "Science"; rawCls = rawCls.replace(/Science/i, "").trim(); }
    else if (rawCls.toLowerCase().includes("arts")) { searchGroup = "Arts"; rawCls = rawCls.replace(/Arts/i, "").trim(); }
    else if (rawCls.toLowerCase().includes("commerce")) { searchGroup = "Commerce"; rawCls = rawCls.replace(/Commerce/i, "").trim(); }
    let searchClass = rawCls.replace(/Class/i, "").trim();
    return { className: searchClass, groupName: searchGroup };
}

async function fetchClassHeaders(db, cls, selectedYear) {
    let baseDocName = cls.replace(/\s+/g, '_');
    let defaultHeaders = ["ID", "Name", "Roll", "", "Total Avg", "GPA", "Grade", "Position", "Fail_Reason", "Year", "Pass_Marks_Rules"];

    if (selectedYear) {
        let yrDocName = baseDocName + "_" + String(selectedYear).trim();
        let yrSnap = await db.collection('ClassHeaders').doc(yrDocName).get();
        if (yrSnap.exists) {
            let data = yrSnap.data() || {};
            if (data.headers) {
                try { return JSON.parse(data.headers); } catch (e) {}
            }
        }
    }

    let baseSnap = await db.collection('ClassHeaders').doc(baseDocName).get();
    if (baseSnap.exists) {
        let data = baseSnap.data() || {};
        if (data.headers) {
            try { return JSON.parse(data.headers); } catch (e) {}
        }
    }
    return defaultHeaders;
}

async function saveClassHeaders(db, cls, headers, selectedYear) {
    let baseDocName = cls.replace(/\s+/g, '_');
    let payload = { headers: JSON.stringify(headers) };

    await db.collection('ClassHeaders').doc(baseDocName).set(payload, { merge: true });
    if (selectedYear) {
        let yrDocName = baseDocName + "_" + String(selectedYear).trim();
        await db.collection('ClassHeaders').doc(yrDocName).set(payload, { merge: true });
    }
}

function getStudentMarksForYear(fields, selectedYear, headers) {
    let yrStr = String(selectedYear || new Date().getFullYear()).trim();
    let yearlyMap = {};
    try { yearlyMap = fields.yearlyMarks ? JSON.parse(fields.yearlyMarks) : {}; } catch (e) { yearlyMap = {}; }

    if (yearlyMap[yrStr] && Array.isArray(yearlyMap[yrStr])) {
        return { row: yearlyMap[yrStr], yearlyMap: yearlyMap };
    }

    let rawLegacy = fields.resultMarks || "";
    if (rawLegacy && rawLegacy.trim() !== "" && rawLegacy !== "[]") {
        try {
            let legacyRow = JSON.parse(rawLegacy);
            if (Array.isArray(legacyRow) && legacyRow.length > 3) {
                let firstEmpty = headers.indexOf("");
                let rowYear = (firstEmpty !== -1 && legacyRow[firstEmpty + 6]) ? String(legacyRow[firstEmpty + 6]).trim() : "";
                if (rowYear === yrStr) {
                    yearlyMap[yrStr] = legacyRow;
                    return { row: legacyRow, yearlyMap: yearlyMap };
                }
            }
        } catch (e) {}
    }

    let blankRow = new Array(headers.length).fill("");
    blankRow[0] = fields.studentID || "";
    blankRow[1] = fields.name || "";
    blankRow[2] = fields.roll || "";
    return { row: blankRow, yearlyMap: yearlyMap };
}

function getStudentYearlyStatusMap(fields) {
    let statusMap = {};
    try { statusMap = fields.yearlyStatus ? JSON.parse(fields.yearlyStatus) : {}; } catch (e) { statusMap = {}; }
    return statusMap;
}

function migrateSingleRowArray(oldRow, newHeaders, oldHeaders) {
    if (!Array.isArray(oldRow) || oldRow.length === 0) return [];
    let oldMap = {};
    oldHeaders.forEach((h, i) => { if (h !== "") oldMap[h] = i; });
    let oldEmpty = oldHeaders.indexOf("");

    let newRow = new Array(newHeaders.length).fill("");
    newRow[0] = oldRow[0] || "";
    newRow[1] = oldRow[1] || "";
    newRow[2] = oldRow[2] || "";

    for (let i = 3; i < newHeaders.length; i++) {
        if (newHeaders[i] === "") {
            for (let j = 1; j <= 7; j++) {
                if (oldEmpty !== -1 && oldRow[oldEmpty + j] !== undefined) {
                    newRow[i + j] = oldRow[oldEmpty + j];
                }
            }
            break;
        } else if (oldMap[newHeaders[i]] !== undefined) {
            newRow[i] = oldRow[oldMap[newHeaders[i]]];
        }
    }
    return newRow;
}

async function migrateClassData(db, className, newHeaders, oldHeaders, selectedYear) {
    let yrStr = String(selectedYear || new Date().getFullYear()).trim();
    let target = parseClassAndGroup(className);
    let snap = await db.collection('Students').get();
    let ops = [];

    snap.forEach(docSnap => {
        let f = docSnap.data() || {};
        let dbClass = (f.class || "").toString().trim();
        let dbGroup = (f.group || "").toString().trim();

        if (dbClass.toLowerCase() === target.className.toLowerCase() && (target.groupName === "" || dbGroup.toLowerCase() === target.groupName.toLowerCase())) {
            let yearlyMap = {};
            try { yearlyMap = f.yearlyMarks ? JSON.parse(f.yearlyMarks) : {}; } catch (e) { yearlyMap = {}; }

            let oldRow = [];
            try { oldRow = f.resultMarks ? JSON.parse(f.resultMarks) : []; } catch (e) { oldRow = []; }

            let hasChanges = false;
            let updates = {};

            if (yearlyMap[yrStr] && Array.isArray(yearlyMap[yrStr]) && yearlyMap[yrStr].length > 0) {
                yearlyMap[yrStr] = migrateSingleRowArray(yearlyMap[yrStr], newHeaders, oldHeaders);
                updates.yearlyMarks = JSON.stringify(yearlyMap);
                hasChanges = true;
            }

            if (Array.isArray(oldRow) && oldRow.length > 0) {
                let newLegacyRow = migrateSingleRowArray(oldRow, newHeaders, oldHeaders);
                updates.resultMarks = JSON.stringify(newLegacyRow);
                hasChanges = true;
            }

            if (hasChanges) {
                ops.push({ type: 'update', ref: docSnap.ref, data: updates });
            }
        }
    });

    if (ops.length > 0) {
        await commitBatchOperations(db, ops);
    }
}

async function executeStandardHeadersReset(db, className, selectedYear, resetMode, targetStudentIds) {
    let yrStr = String(selectedYear || new Date().getFullYear()).trim();
    let mode = resetMode || "full_year";
    let stdHeaders = ["ID", "Name", "Roll", "", "Total Avg", "GPA", "Grade", "Position", "Fail_Reason", "Year", "Pass_Marks_Rules"];

    if (mode === "full_year") {
        await saveClassHeaders(db, className, stdHeaders, yrStr);
    }

    let target = parseClassAndGroup(className);
    let snap = await db.collection('Students').get();
    let ops = [];

    snap.forEach(docSnap => {
        let f = docSnap.data() || {};
        let dbClass = (f.class || "").toString().trim();
        let dbGroup = (f.group || "").toString().trim();
        let sId = (f.studentID || "").toString().trim();

        if (dbClass.toLowerCase() === target.className.toLowerCase() && (target.groupName === "" || dbGroup.toLowerCase() === target.groupName.toLowerCase())) {
            if (mode === "selected_students" && Array.isArray(targetStudentIds) && targetStudentIds.length > 0) {
                if (!targetStudentIds.includes(sId) && !targetStudentIds.includes(docSnap.id)) return;
            }

            let yearlyMap = {};
            try { yearlyMap = f.yearlyMarks ? JSON.parse(f.yearlyMarks) : {}; } catch (e) { yearlyMap = {}; }
            let statusMap = getStudentYearlyStatusMap(f);

            delete yearlyMap[yrStr];
            delete statusMap[yrStr];

            let rawLegacy = f.resultMarks || "[]";
            let clearLegacy = true;
            try {
                let legArr = JSON.parse(rawLegacy);
                let fe = legArr.indexOf("");
                if (fe !== -1 && legArr[fe + 6] && String(legArr[fe + 6]).trim() !== "" && String(legArr[fe + 6]).trim() !== yrStr) {
                    clearLegacy = false;
                }
            } catch (e) {}

            let updates = {
                yearlyMarks: JSON.stringify(yearlyMap),
                yearlyStatus: JSON.stringify(statusMap)
            };

            if (clearLegacy) {
                updates.resultMarks = "[]";
                updates.resultStatus = "";
            }

            ops.push({ type: 'update', ref: docSnap.ref, data: updates });
        }
    });

    if (ops.length > 0) {
        await commitBatchOperations(db, ops);
    }

    if (mode === "marks_only") {
        return { status: "success", msg: `✅ ${yrStr} শিক্ষাবর্ষের সকল নম্বর সফলভাবে রিসেট (Blank) করা হয়েছে! (বিষয়সমূহ অক্ষুণ্ণ আছে)` };
    } else if (mode === "selected_students") {
        return { status: "success", msg: `✅ নির্বাচিত শিক্ষার্থীদের (${yrStr} শিক্ষাবর্ষ) নম্বর সফলভাবে রিসেট করা হয়েছে!` };
    }
    return { status: "success", msg: `✅ ${yrStr} শিক্ষাবর্ষের ফরম্যাট ও নম্বর রিসেট সম্পন্ন হয়েছে! অন্য সকল বছরের তথ্য সুরক্ষিত আছে।` };
}

async function executeArchiveClassYearData(db, className, selectedYear, archiveLabel, configPayload) {
    let yrStr = String(selectedYear || new Date().getFullYear()).trim();
    let label = archiveLabel ? String(archiveLabel).trim() : ("Final Archive - " + yrStr);
    let headers = await fetchClassHeaders(db, className, yrStr);

    await saveClassHeaders(db, className, headers, yrStr);

    let target = parseClassAndGroup(className);
    let studentsSnap = await db.collection('Students').get();
    let archivedStudents = [];
    let ops = [];

    studentsSnap.forEach(docSnap => {
        let f = docSnap.data() || {};
        let dbClass = (f.class || "").toString().trim();
        let dbGroup = (f.group || "").toString().trim();

        if (dbClass.toLowerCase() === target.className.toLowerCase() && (target.groupName === "" || dbGroup.toLowerCase() === target.groupName.toLowerCase())) {
            let yrInfo = getStudentMarksForYear(f, yrStr, headers);
            let row = yrInfo.row;
            let yearlyMap = yrInfo.yearlyMap;
            let statusMap = getStudentYearlyStatusMap(f);

            yearlyMap[yrStr] = row;
            statusMap[yrStr] = statusMap[yrStr] || "Archived";

            archivedStudents.push({
                docId: docSnap.id,
                studentID: f.studentID || "",
                name: f.name || "",
                roll: f.roll || "",
                phone: f.phone || "",
                email: f.email || "",
                marks: row
            });

            ops.push({
                type: 'update',
                ref: docSnap.ref,
                data: {
                    yearlyMarks: JSON.stringify(yearlyMap),
                    yearlyStatus: JSON.stringify(statusMap)
                }
            });
        }
    });

    if (ops.length > 0) await commitBatchOperations(db, ops);

    const archiveDocId = className.replace(/\s+/g, '_') + "_" + yrStr;
    await db.collection('ResultArchives').doc(archiveDocId).set({
        className: className,
        year: yrStr,
        archiveLabel: label,
        archivedAt: new Date().toISOString(),
        studentCount: archivedStudents.length,
        headers: JSON.stringify(headers),
        configPayload: configPayload || "{}",
        studentsData: JSON.stringify(archivedStudents)
    }, { merge: true });

    return {
        status: "success",
        archiveId: archiveDocId,
        msg: `✅ আলহামদুলিল্লাহ! ${className} (${yrStr} শিক্ষাবর্ষ)-এর ${archivedStudents.length} জন শিক্ষার্থীর সম্পূর্ণ ফলাফল ডেটাবেসে স্থায়ীভাবে আর্কাইভ করা হয়েছে!`
    };
}


// ============================================================================
// 🌐 5. MAIN HTTP ROUTES (GET & POST)
// ============================================================================

router.get('/', (req, res) => {
    res.send('<h3 style="color:#005f40; font-family:sans-serif; text-align:center; margin-top:50px;">✅ Saidpur Residential Model School — Result Management & Multi-Year Archive Server Online.</h3>');
});

router.post('/', async (req, res) => {
    try {
        const payload = req.body || {};
        const action = payload.action;
        const token = payload.token || "";
        const adminKey = payload.adminKey || "";
        const db = admin.firestore();

        const isAuthorized = await verifyAdminAccess(token, adminKey);
        if (!isAuthorized) {
            return res.status(401).json({ status: "error", message: "অনুমোদনহীন অ্যাক্সেস প্রতিরোধ করা হয়েছে।" });
        }

        // ====================================================================
        // 📚 ACTION 1-4: GLOBAL EXAMS MANAGEMENT (Get / Add / Edit / Delete)
        // ====================================================================
        if (action === 'getGlobalExams') {
            const doc = await db.collection('Admin').doc('Settings').get();
            let globalExams = [];
            if (doc.exists) {
                const data = doc.data() || {};
                if (data.globalExams) {
                    try { globalExams = JSON.parse(data.globalExams); } catch (e) { globalExams = []; }
                }
            }
            return res.json({ status: "success", data: globalExams });
        }

        if (action === 'addGlobalExam') {
            const examName = (payload.examName || "").toString().trim();
            const examType = payload.examType || "Main";
            const docRef = db.collection('Admin').doc('Settings');
            const doc = await docRef.get();
            let globalExams = [];
            if (doc.exists) {
                try { globalExams = JSON.parse(doc.data().globalExams || "[]"); } catch (e) { globalExams = []; }
            }
            if (globalExams.some(e => e.name.toLowerCase() === examName.toLowerCase())) {
                return res.json({ status: "error", message: "Exam already exists!" });
            }
            globalExams.push({ name: examName, type: examType });
            await docRef.set({ globalExams: JSON.stringify(globalExams) }, { merge: true });
            return res.json({ status: "success", msg: "✅ নতুন পরীক্ষা সফলভাবে যুক্ত হয়েছে!" });
        }

        if (action === 'editGlobalExam') {
            const oldName = payload.oldName;
            const newName = payload.newName;
            const newType = payload.newType;

            const docRef = db.collection('Admin').doc('Settings');
            const doc = await docRef.get();
            let globalExams = [];
            if (doc.exists) {
                try { globalExams = JSON.parse(doc.data().globalExams || "[]"); } catch (e) { globalExams = []; }
            }

            const foundIndex = globalExams.findIndex(e => e.name === oldName);
            if (foundIndex === -1) {
                return res.json({ status: "error", message: "Exam not found!" });
            }

            globalExams[foundIndex].name = newName;
            globalExams[foundIndex].type = newType;
            await docRef.set({ globalExams: JSON.stringify(globalExams) }, { merge: true });

            const headersSnap = await db.collection('ClassHeaders').get();
            const ops = [];
            headersSnap.forEach(d => {
                const f = d.data() || {};
                if (f.headers) {
                    let hArr = [];
                    try { hArr = JSON.parse(f.headers); } catch (e) { hArr = []; }
                    let updated = false;
                    const newHArr = hArr.map(h => {
                        if (h.includes(" - " + oldName + " - ")) {
                            updated = true;
                            const parts = h.split(" - ");
                            if (parts.length >= 3) {
                                const restIndex = parts[2].indexOf(" (");
                                const rest = restIndex !== -1 ? parts[2].substring(restIndex) : "";
                                return `${parts[0]} - ${newName} - ${newType}${rest}`;
                            }
                        }
                        return h;
                    });
                    if (updated) {
                        ops.push({
                            type: 'set',
                            ref: d.ref,
                            data: { headers: JSON.stringify(newHArr) },
                            options: { merge: true }
                        });
                    }
                }
            });
            if (ops.length > 0) await commitBatchOperations(db, ops);

            return res.json({ status: "success", msg: "✅ পরীক্ষার নাম সকল ক্লাসে স্বয়ংক্রিয়ভাবে আপডেট হয়েছে!" });
        }

        if (action === 'deleteGlobalExam') {
            const examName = payload.examName;
            const docRef = db.collection('Admin').doc('Settings');
            const doc = await docRef.get();
            let globalExams = [];
            if (doc.exists) {
                try { globalExams = JSON.parse(doc.data().globalExams || "[]"); } catch (e) { globalExams = []; }
            }
            globalExams = globalExams.filter(e => e.name !== examName);
            await docRef.set({ globalExams: JSON.stringify(globalExams) }, { merge: true });
            return res.json({ status: "success", msg: "✅ পরীক্ষা সফলভাবে মুছে ফেলা হয়েছে!" });
        }

        // ====================================================================
        // 📐 ACTION 5-9: SUBJECTS, HEADERS & EXAM LINKING ENGINE
        // ====================================================================
        if (action === 'setupStandardHeaders') {
            const result = await executeStandardHeadersReset(
                db,
                payload.className,
                payload.selectedYear,
                payload.resetMode,
                payload.targetStudentIds
            );
            return res.json(result);
        }

        if (action === 'addSubjectAdvanced') {
            const className = payload.className;
            const subData = payload.subjectData || {};
            const selectedYear = payload.selectedYear;

            const headers = await fetchClassHeaders(db, className, selectedYear);
            const firstEmptyCol = headers.indexOf("");
            if (firstEmptyCol === -1) {
                return res.json({ status: "error", message: "Format Error! Click 'Format Reset' first." });
            }

            const newCols = [];
            if (subData.isOpt) newCols.push(subData.name + " Opt Name");

            if (!subData.selectedExams || subData.selectedExams.length === 0) {
                newCols.push(subData.name + " - [Pending Exam]");
            } else {
                subData.selectedExams.forEach(ex => {
                    const label = subData.isOpt ? "[Opt]" : "[General]";
                    newCols.push(`${subData.name} - ${ex.name} - ${ex.type} (${ex.marks}) ${label}`);
                });
            }

            const newHeaders = [...headers];
            newHeaders.splice(firstEmptyCol, 0, ...newCols);
            await saveClassHeaders(db, className, newHeaders, selectedYear);
            await migrateClassData(db, className, newHeaders, headers, selectedYear);

            return res.json({ status: "success", msg: `✅ '${subData.name}' বিষয়টি সফলভাবে যুক্ত হয়েছে!` });
        }

        if (action === 'updateSubjectAdvanced') {
            const className = payload.className;
            const updatedData = payload.subjectData || {};
            const selectedYear = payload.selectedYear;

            const headers = await fetchClassHeaders(db, className, selectedYear);
            const firstEmptyCol = headers.indexOf("");
            if (firstEmptyCol === -1) return res.json({ status: "error", message: "Format Error!" });

            const oldName = updatedData.oldName;
            const simulatedOldHeaders = headers.map(h => {
                if (h.startsWith(oldName + " - ") || h.includes(oldName + " Opt Name")) {
                    return h.replace(oldName, updatedData.name);
                }
                return h;
            });

            const newHeaders = [];
            simulatedOldHeaders.forEach(h => {
                const subName = h.includes("Opt Name") ? h.replace(" Opt Name", "").trim() : h.split(" - ")[0].trim();
                if (subName !== updatedData.name) {
                    newHeaders.push(h);
                }
            });

            const newCols = [];
            if (updatedData.isOpt) newCols.push(updatedData.name + " Opt Name");
            if (!updatedData.selectedExams || updatedData.selectedExams.length === 0) {
                newCols.push(updatedData.name + " - [Pending Exam]");
            } else {
                updatedData.selectedExams.forEach(ex => {
                    const label = updatedData.isOpt ? "[Opt]" : "[General]";
                    newCols.push(`${updatedData.name} - ${ex.name} - ${ex.type} (${ex.marks}) ${label}`);
                });
            }

            let firstEmpty = newHeaders.indexOf("");
            if (firstEmpty === -1) firstEmpty = newHeaders.length;
            newHeaders.splice(firstEmpty, 0, ...newCols);

            await saveClassHeaders(db, className, newHeaders, selectedYear);
            await migrateClassData(db, className, newHeaders, simulatedOldHeaders, selectedYear);

            return res.json({ status: "success", msg: "✅ বিষয়টি সফলভাবে আপডেট এবং নম্বর মাইগ্রেট করা হয়েছে!" });
        }

        if (action === 'linkExamToClassSubjects') {
            const className = payload.className;
            const examData = payload.examData || {};
            const selectedYear = payload.selectedYear;

            const headers = await fetchClassHeaders(db, className, selectedYear);
            const firstEmptyCol = headers.indexOf("");
            if (firstEmptyCol === -1) return res.json({ status: "error", message: "Format Error!" });

            const newHeaders = [];
            for (let i = 0; i < headers.length; i++) {
                const h = headers[i];
                newHeaders.push(h);

                if (i < firstEmptyCol && h !== "") {
                    const subName = h.includes("Opt Name") ? h.replace(" Opt Name", "").trim() : h.split(" - ")[0].trim();
                    const isTargetSubject = (examData.subjects || []).includes(subName);
                    const isLastColOfSub = (i === firstEmptyCol - 1) || (headers[i + 1] && !headers[i + 1].startsWith(subName + " -") && !headers[i + 1].includes(subName + " Opt Name"));

                    if (isTargetSubject && isLastColOfSub) {
                        const isOpt = h.includes("Opt Name") || h.includes("[Opt]");
                        const label = isOpt ? "[Opt]" : "[General]";
                        const newColStr = `${subName} - ${examData.examName} - ${examData.examType} (${examData.marks}) ${label}`;

                        let examExists = false;
                        for (let j = 0; j <= i; j++) {
                            if (headers[j] === newColStr) { examExists = true; break; }
                        }

                        if (!examExists) {
                            if (h === `${subName} - [Pending Exam]`) {
                                newHeaders[newHeaders.length - 1] = newColStr;
                            } else {
                                newHeaders.push(newColStr);
                            }
                        }
                    }
                }
            }

            await saveClassHeaders(db, className, newHeaders, selectedYear);
            await migrateClassData(db, className, newHeaders, headers, selectedYear);

            return res.json({ status: "success", msg: "✅ পরীক্ষা সফলভাবে বিষয়সমূহে লিংক করা হয়েছে!" });
        }

        if (action === 'deleteSubjectColumn') {
            const className = payload.className;
            const colIndex = payload.colIndex;
            const selectedYear = payload.selectedYear;

            const headers = await fetchClassHeaders(db, className, selectedYear);
            let subName = "";
            if (headers[colIndex] && headers[colIndex].includes("Opt Name")) {
                subName = headers[colIndex].replace(" Opt Name", "").trim();
            } else if (headers[colIndex]) {
                subName = headers[colIndex].split(" - ")[0].trim();
            }

            const emptyIdx = headers.indexOf("");
            const newHeaders = headers.filter((h, idx) => {
                if (idx < 3 || idx >= emptyIdx) return true;
                const currentSubName = h.includes("Opt Name") ? h.replace(" Opt Name", "").trim() : h.split(" - ")[0].trim();
                return currentSubName !== subName;
            });

            await saveClassHeaders(db, className, newHeaders, selectedYear);
            await migrateClassData(db, className, newHeaders, headers, selectedYear);

            return res.json({ status: "success", msg: "✅ বিষয় এবং এর পরীক্ষাগুলো নিরাপদে মুছে ফেলা হয়েছে!" });
        }

        // Save Raw Marks (Direct Row Save Compatibility)
        if (action === 'saveRawMarks') {
            const rowId = payload.rowId;
            const rowData = payload.rowData || [];
            const selectedYear = payload.selectedYear;
            const docRef = db.collection('Students').doc(rowId);

            const updates = {
                resultMarks: JSON.stringify(rowData),
                resultStatus: "Draft"
            };

            if (selectedYear) {
                const snap = await docRef.get();
                if (snap.exists) {
                    const f = snap.data() || {};
                    let yearlyMap = {};
                    try { yearlyMap = f.yearlyMarks ? JSON.parse(f.yearlyMarks) : {}; } catch (e) { yearlyMap = {}; }
                    yearlyMap[String(selectedYear).trim()] = rowData;
                    updates.yearlyMarks = JSON.stringify(yearlyMap);
                }
            }

            await docRef.update(updates);
            return res.json({ status: "success", updatedRow: rowData, msg: "Marks saved directly to DB." });
        }

        // ====================================================================
        // ⚙️ ACTION 10: CALCULATE ALL CLASS RESULTS
        // ====================================================================
        if (action === 'calculateAllClassResults') {
            const className = payload.className;
            const selectedYear = payload.selectedYear;
            const configPayload = payload.configPayload || "{}";
            const yrStr = String(selectedYear || new Date().getFullYear()).trim();

            let config = {};
            try { config = JSON.parse(configPayload); } catch (e) {}

            const testWeight = parseFloat(config.testWeight || payload.testWeightStr) || 25;
            const mainWeight = parseFloat(config.mainWeight || payload.mainWeightStr) || 75;
            const reqIndividualPass = config.reqIndividualPass === true;
            const passRatio = (parseFloat(config.passPercentage || payload.passPercentage) || 33) / 100;

            const headers = await fetchClassHeaders(db, className, yrStr);
            const firstEmptyCol = headers.indexOf("");
            if (firstEmptyCol === -1) return res.json({ status: "error", message: "Format Error! Please set up columns." });

            let subjects = {};
            let c = 3;
            while (c < firstEmptyCol && c < headers.length) {
                let startC = c;
                if (headers[c].includes("Opt Name")) {
                    let optSubName = headers[c].replace(" Opt Name", "").trim();
                    if (!subjects[optSubName]) subjects[optSubName] = { isOpt: true, tests: [], mains: [] };
                    let j = c + 1;
                    while (j < firstEmptyCol && headers[j].startsWith(optSubName + " - ")) {
                        if (headers[j].includes(" - Test ")) subjects[optSubName].tests.push(j);
                        else if (headers[j].includes(" - Main ")) subjects[optSubName].mains.push(j);
                        j++;
                    }
                    c = j;
                } else {
                    let subName = headers[c].split(" - ")[0].trim();
                    if (!subjects[subName]) subjects[subName] = { isOpt: headers[c].includes("[Opt]"), tests: [], mains: [] };
                    let j = c;
                    while (j < firstEmptyCol && headers[j].startsWith(subName + " - ")) {
                        if (headers[j].includes(" - Test ")) subjects[subName].tests.push(j);
                        else if (headers[j].includes(" - Main ")) subjects[subName].mains.push(j);
                        j++;
                    }
                    c = j;
                }
                if (c === startC) c++;
            }

            const target = parseClassAndGroup(className);
            const studentsSnap = await db.collection('Students').get();
            let studentStats = [];

            studentsSnap.forEach(docSnap => {
                let f = docSnap.data() || {};
                let dbClass = (f.class || "").toString().trim();
                let dbGroup = (f.group || "").toString().trim();

                if (dbClass.toLowerCase() === target.className.toLowerCase() && (target.groupName === "" || dbGroup.toLowerCase() === target.groupName.toLowerCase())) {
                    let yrInfo = getStudentMarksForYear(f, yrStr, headers);
                    let row = yrInfo.row;
                    let yearlyMap = yrInfo.yearlyMap;
                    let statusMap = getStudentYearlyStatusMap(f);

                    if (row.length < headers.length) {
                        row = row.concat(new Array(headers.length - row.length).fill(""));
                    }

                    row[0] = f.studentID || "";
                    row[1] = f.name || "";
                    row[2] = f.roll || "";

                    let totalMarks = 0, totalRegularGP = 0, optExtraGP = 0;
                    let regularSubCount = 0, totalSubCount = 0, isFail = false;
                    let attendedExams = 0, incompleteTerm = false;
                    let failReasonsArray = [];

                    Object.keys(subjects).forEach(subName => {
                        let sub = subjects[subName];
                        let tCalc = 0, mCalc = 0;
                        let hasTest = false, hasMain = false, isSubFail = false;
                        let totalTFull = 0, totalMFull = 0;
                        let specificReason = "";

                        sub.tests.forEach(tCol => {
                            let vStr = String(row[tCol] || "").trim();
                            let fParts = parsePartsFromHeader(headers[tCol]);
                            let tf = fParts.reduce((a, b) => a + b.max, 0);
                            totalTFull += tf;

                            if (vStr !== "") {
                                hasTest = true;
                                let oParts = vStr.includes("+") ? vStr.split('+').map(Number) : [parseFloat(vStr) || 0];
                                let sumT = 0;
                                for (let i = 0; i < fParts.length; i++) {
                                    let obt = oParts[i] || 0;
                                    if (obt > fParts[i].max) obt = fParts[i].max;
                                    sumT += obt;
                                }
                                tCalc += sumT;
                            }
                        });

                        sub.mains.forEach(mCol => {
                            let vStr = String(row[mCol] || "").trim();
                            let fParts = parsePartsFromHeader(headers[mCol]);
                            let mf = fParts.reduce((a, b) => a + b.max, 0);
                            totalMFull += mf;

                            if (vStr !== "") {
                                hasMain = true;
                                let oParts = vStr.includes("+") ? vStr.split('+').map(Number) : [parseFloat(vStr) || 0];
                                let sumM = 0;

                                for (let i = 0; i < fParts.length; i++) {
                                    let obt = oParts[i] || 0;
                                    let max = fParts[i].max;
                                    if (obt > max) obt = max;
                                    sumM += obt;

                                    if (reqIndividualPass && max > 0 && obt < Math.ceil(max * passRatio)) {
                                        isSubFail = true;
                                        specificReason = fParts[i].name;
                                    }
                                }

                                mCalc += sumM;
                                if (sumM < Math.ceil(mf * passRatio)) { isSubFail = true; specificReason = "Total Marks"; }
                            }
                        });

                        if (hasTest && !hasMain && sub.mains.length > 0) incompleteTerm = true;

                        if (hasTest || hasMain) {
                            attendedExams++;
                            let finalMark = 0;
                            if (hasTest && hasMain && totalTFull > 0 && totalMFull > 0) finalMark = Math.round(((tCalc / totalTFull) * testWeight) + ((mCalc / totalMFull) * mainWeight));
                            else if (!hasTest && hasMain && totalMFull > 0) finalMark = Math.round((mCalc / totalMFull) * 100);
                            else if (hasTest && !hasMain && totalTFull > 0) finalMark = Math.round((tCalc / totalTFull) * 100);

                            if (!isSubFail && finalMark < Math.ceil(100 * passRatio)) { isSubFail = true; specificReason = "Final Total"; }

                            let gp = getGP(finalMark);
                            if (isSubFail || gp === 0.00) {
                                if (!sub.isOpt) { isFail = true; failReasonsArray.push(subName + (specificReason ? " (" + specificReason + ")" : "")); }
                            } else {
                                if (sub.isOpt && gp > 2.00) optExtraGP += (gp - 2.00);
                            }

                            if (!sub.isOpt) { totalRegularGP += gp; regularSubCount++; }
                            totalMarks += finalMark; totalSubCount++;
                        }
                    });

                    if (attendedExams === 0) {
                        row[firstEmptyCol + 1] = ""; row[firstEmptyCol + 2] = ""; row[firstEmptyCol + 3] = ""; row[firstEmptyCol + 4] = ""; row[firstEmptyCol + 5] = ""; row[firstEmptyCol + 6] = yrStr;
                        studentStats.push({ docRef: docSnap.ref, rowData: row, yearlyMap: yearlyMap, statusMap: statusMap, isValid: false });
                    } else {
                        let finalGPA = 0.00, finalGrade = "F";
                        let grandTotalAvg = totalSubCount > 0 ? (totalMarks / totalSubCount).toFixed(2) : "";

                        if (incompleteTerm) {
                            finalGPA = 0.00; finalGrade = "Incomplete"; isFail = true;
                            failReasonsArray = ["Exams Incomplete"];
                        } else if (regularSubCount > 0) {
                            if (isFail) { finalGPA = 0.00; finalGrade = "F"; }
                            else {
                                let combinedGP = totalRegularGP + optExtraGP;
                                finalGPA = combinedGP / regularSubCount;
                                if (finalGPA > 5.00) finalGPA = 5.00;
                                finalGrade = getGrade(parseFloat(finalGPA));
                            }
                        }
                        row[firstEmptyCol + 1] = grandTotalAvg;
                        row[firstEmptyCol + 2] = regularSubCount > 0 ? parseFloat(finalGPA).toFixed(2) : "";
                        row[firstEmptyCol + 3] = finalGrade;
                        row[firstEmptyCol + 5] = failReasonsArray.length > 0 ? failReasonsArray.join(", ") : "None";
                        row[firstEmptyCol + 6] = yrStr;
                        studentStats.push({ docRef: docSnap.ref, rowData: row, yearlyMap: yearlyMap, statusMap: statusMap, isValid: true, gpa: parseFloat(finalGPA) || 0, totalMarks: totalMarks, isFail: isFail, attendedExams: attendedExams });
                    }
                }
            });

            let validStudents = studentStats.filter(s => s.isValid);
            validStudents.sort((a, b) => {
                if (a.isFail && !b.isFail) return 1;
                if (!a.isFail && b.isFail) return -1;
                if (b.attendedExams !== a.attendedExams) return b.attendedExams - a.attendedExams;
                if (b.gpa !== a.gpa) return b.gpa - a.gpa;
                return b.totalMarks - a.totalMarks;
            });

            let currentRank = 1;
            for (let i = 0; i < validStudents.length; i++) {
                let stat = validStudents[i];
                let dataRow = stat.rowData;
                if (stat.isFail) { dataRow[firstEmptyCol + 4] = "N/A"; }
                else {
                    if (i > 0 && validStudents[i].attendedExams === validStudents[i - 1].attendedExams && validStudents[i].gpa === validStudents[i - 1].gpa && validStudents[i].totalMarks === validStudents[i - 1].totalMarks && !validStudents[i - 1].isFail) {
                        dataRow[firstEmptyCol + 4] = validStudents[i - 1].rowData[firstEmptyCol + 4];
                    } else {
                        let s = ["th", "st", "nd", "rd"], v = currentRank % 100;
                        dataRow[firstEmptyCol + 4] = currentRank + (s[(v - 20) % 10] || s[v] || s[0]);
                    }
                    currentRank++;
                }
            }

            let ops = [];
            studentStats.forEach(stat => {
                stat.yearlyMap[yrStr] = stat.rowData;
                stat.statusMap[yrStr] = "Calculated";
                ops.push({
                    type: 'update',
                    ref: stat.docRef,
                    data: {
                        resultMarks: JSON.stringify(stat.rowData),
                        resultStatus: "Calculated",
                        yearlyMarks: JSON.stringify(stat.yearlyMap),
                        yearlyStatus: JSON.stringify(stat.statusMap)
                    }
                });
            });

            if (ops.length > 0) await commitBatchOperations(db, ops);
            return res.json({ status: "success", msg: `✅ ${yrStr} শিক্ষাবর্ষের সকল ফলাফল ও মেধাক্রম সফলভাবে হিসাব ও সংরক্ষণ করা হয়েছে!` });
        }

        // ====================================================================
        // 🗄️ ACTION 11-14: MULTI-YEAR ARCHIVE, RESTORE & DELETE ENGINE
        // ====================================================================
        if (action === 'archiveClassYearData') {
            const result = await executeArchiveClassYearData(
                db,
                payload.className,
                payload.selectedYear,
                payload.archiveLabel,
                payload.configPayload
            );
            return res.json(result);
        }

        if (action === 'getClassArchives') {
            const className = payload.className;
            const snap = await db.collection('ResultArchives').get();
            let archives = [];
            snap.forEach(doc => {
                let f = doc.data() || {};
                if (!className || f.className === className) {
                    archives.push({
                        archiveDocId: doc.id,
                        className: f.className || "",
                        year: f.year || "",
                        archiveLabel: f.archiveLabel || "",
                        archivedAt: f.archivedAt || "",
                        studentCount: parseInt(f.studentCount || 0, 10),
                        headers: f.headers || "[]",
                        configPayload: f.configPayload || "{}",
                        studentsData: f.studentsData || "[]"
                    });
                }
            });
            archives.sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
            return res.json({ status: "success", data: archives });
        }

        if (action === 'deleteClassArchive') {
            const archiveDocId = payload.archiveDocId;
            const className = payload.className;
            const targetYear = payload.targetYear;
            const deleteMode = payload.deleteMode;

            if (archiveDocId) {
                await db.collection('ResultArchives').doc(archiveDocId).delete();
            }

            if (deleteMode === "archive_and_year_marks" && className && targetYear) {
                await executeStandardHeadersReset(db, className, targetYear, "full_year", []);
                return res.json({ status: "success", msg: `✅ আর্কাইভ এবং ${targetYear} শিক্ষাবর্ষের ফলাফল সম্পূর্ণভাবে ডিলিট করা হয়েছে!` });
            }

            return res.json({ status: "success", msg: "✅ নির্বাচিত আর্কাইভ স্ন্যাপশট সফলভাবে ডিলিট করা হয়েছে!" });
        }

        if (action === 'restoreArchiveToActive') {
            const archiveDocId = payload.archiveDocId;
            const snap = await db.collection('ResultArchives').doc(archiveDocId).get();
            if (!snap.exists) {
                return res.json({ status: "error", message: "আর্কাইভ ডকুমেন্ট খুঁজে পাওয়া যায়নি!" });
            }

            const f = snap.data() || {};
            const className = f.className || "";
            const yrStr = f.year || "";
            let headers = [];
            let studentsData = [];
            try { headers = JSON.parse(f.headers || "[]"); } catch (e) { headers = []; }
            try { studentsData = JSON.parse(f.studentsData || "[]"); } catch (e) { studentsData = []; }

            if (!className || !yrStr) {
                return res.json({ status: "error", message: "আর্কাইভ ডেটা অসম্পূর্ণ!" });
            }

            await saveClassHeaders(db, className, headers, yrStr);

            const target = parseClassAndGroup(className);
            const sSnap = await db.collection('Students').get();
            const stuById = {};
            studentsData.forEach(s => {
                if (s.studentID) stuById[String(s.studentID).trim()] = s.marks;
            });

            const ops = [];
            sSnap.forEach(d => {
                const sf = d.data() || {};
                const dbClass = (sf.class || "").toString().trim();
                const dbGroup = (sf.group || "").toString().trim();
                const sId = (sf.studentID || "").toString().trim();

                if (dbClass.toLowerCase() === target.className.toLowerCase() && (target.groupName === "" || dbGroup.toLowerCase() === target.groupName.toLowerCase())) {
                    if (stuById[sId]) {
                        let yearlyMap = {};
                        try { yearlyMap = sf.yearlyMarks ? JSON.parse(sf.yearlyMarks) : {}; } catch (e) { yearlyMap = {}; }
                        yearlyMap[yrStr] = stuById[sId];
                        ops.push({
                            type: 'update',
                            ref: d.ref,
                            data: {
                                yearlyMarks: JSON.stringify(yearlyMap),
                                resultMarks: JSON.stringify(stuById[sId])
                            }
                        });
                    }
                }
            });

            if (ops.length > 0) await commitBatchOperations(db, ops);
            return res.json({ status: "success", msg: `✅ ${className} (${yrStr} শিক্ষাবর্ষ)-এর আর্কাইভকৃত ফলাফল সফলভাবে রিস্টোর করা হয়েছে!` });
        }

        // ====================================================================
        // 📢 ACTION 15: PUBLISH RESULT & SEND BULKSMSBD + ONESIGNAL EMAIL
        // ====================================================================
        if (action === 'publishAndSendSMS') {
            const className = payload.className;
            const examTerm = payload.examTerm || "Annual Exam";
            const year = payload.year;
            const sendSmsCheck = payload.sendSmsCheck === true;
            const yrStr = String(year || new Date().getFullYear()).trim();

            const headers = await fetchClassHeaders(db, className, yrStr);
            const firstEmptyCol = headers.indexOf("");
            if (firstEmptyCol === -1) {
                return res.json({ status: "error", message: "Error: Invalid Headers for SMS" });
            }

            const target = parseClassAndGroup(className);
            const studentsSnap = await db.collection('Students').get();

            let ops = [];
            let notificationTasks = [];

            studentsSnap.forEach(docSnap => {
                let f = docSnap.data() || {};
                let dbClass = (f.class || "").toString().trim();
                let dbGroup = (f.group || "").toString().trim();

                if (dbClass.toLowerCase() === target.className.toLowerCase() && (target.groupName === "" || dbGroup.toLowerCase() === target.groupName.toLowerCase())) {
                    let sName = f.name || "";
                    let sId = f.studentID || "";
                    let sPhone = f.phone || "";
                    let sEmail = f.email || "";

                    let yrInfo = getStudentMarksForYear(f, yrStr, headers);
                    let marksArr = yrInfo.row;
                    let statusMap = getStudentYearlyStatusMap(f);
                    statusMap[yrStr] = "Published";

                    ops.push({
                        type: 'update',
                        ref: docSnap.ref,
                        data: {
                            resultStatus: "Published",
                            yearlyStatus: JSON.stringify(statusMap)
                        }
                    });

                    if (sendSmsCheck && marksArr && marksArr.length > firstEmptyCol + 3) {
                        let gpa = marksArr[firstEmptyCol + 2] || "0.00";
                        let grade = marksArr[firstEmptyCol + 3] || "F";
                        let rank = marksArr[firstEmptyCol + 4] || "N/A";

                        if (marksArr[firstEmptyCol + 2] && grade !== "Incomplete") {
                            let smsBody = `🏫 SRMS Result Published!\nName: ${sName}\nID: ${sId}\nExam: ${examTerm} (${yrStr})\nGPA: ${gpa}\nGrade: ${grade}\nVisit portal for details.`;

                            if (sPhone) {
                                notificationTasks.push(sendSMS(sPhone, smsBody));
                            }

                            if (sEmail && sEmail.includes("@")) {
                                let emailSubject = `SRMS Result Published - ${sName} (${examTerm} - ${yrStr})`;
                                let emailHTML = `
                                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 10px;">
                                        <h2 style="color: #005f40; text-align: center; margin-top: 0;">Academic Result Published</h2>
                                        <p>Dear Guardian,</p>
                                        <p>The result for <b>${sName}</b> (ID: <b>${sId}</b>, Class: <b>${className}</b>) for the exam <b>${examTerm} (${yrStr})</b> has been officially published.</p>
                                        <div style="background: #f0fdf4; padding: 15px; border-radius: 8px; border: 1px solid #bbf7d0; margin: 18px 0;">
                                            <p style="margin: 5px 0; font-size: 16px; color: #166534;"><b>GPA:</b> ${gpa}</p>
                                            <p style="margin: 5px 0; font-size: 16px; color: #166534;"><b>Grade:</b> ${grade}</p>
                                            <p style="margin: 5px 0; font-size: 14px; color: #0f172a;"><b>Merit Position:</b> ${rank}</p>
                                        </div>
                                        <p>Please log in to the SRMS Student / Guardian Portal to view and download the detailed digital marksheet.</p>
                                        <p style="margin-top: 20px;">Regards,<br><b>Saidpur Residential Model School (SRMS)</b></p>
                                    </div>
                                `;
                                notificationTasks.push(sendEmailNotification(sEmail, emailSubject, emailHTML, smsBody));
                            }
                        }
                    }
                }
            });

            if (ops.length > 0) await commitBatchOperations(db, ops);

            try {
                await executeArchiveClassYearData(db, className, yrStr, `${examTerm} (${yrStr})`, "{}");
            } catch (e) {}

            if (notificationTasks.length > 0) {
                await Promise.allSettled(notificationTasks);
                return res.json({ status: "success", msg: "✅ ফলাফল প্রকাশিত ও আর্কাইভ হয়েছে এবং অভিভাবকদের মোবাইলে SMS ও Email পাঠানো হয়েছে!" });
            }

            return res.json({ status: "success", msg: "✅ ফলাফল সফলভাবে প্রকাশিত এবং আর্কাইভে সংরক্ষিত হয়েছে!" });
        }

        return res.status(400).json({ status: "error", message: "Unknown Action: " + action });

    } catch (error) {
        console.error("API Error in Result Management:", error);
        return res.status(500).json({ status: "error", message: error.message || error.toString() });
    }
});

module.exports = router;
