import { OpenAI } from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function isObject(item) {
    return item && typeof item === 'object' && !Array.isArray(item);
}

function isAcronym(word) {
    return /^[A-Z0-9]{2,}$/.test(word);
}

// function isCodeLikeContent(value) {
//     const codePatterns = [
//         /%s/, /PRIMARY\s+KEY/i, /\bvarchar\b/i, /\bint\b/i, /;/, /\(\s*\)/, /^\s*[\w\s]+\([\w\s,]*\)/
//     ];
//     return codePatterns.some(pattern => pattern.test(value));
// }

function isCodeLikeContent(value) {
    const codePatterns = [
        /PRIMARY\s+KEY/i, /\bvarchar\b/i, /\bint\b/i, /;/, /\(\s*\)/, /^\s*[\w\s]+\([\w\s,]*\)/, /%s/i
    ];
    return codePatterns.some(pattern => pattern.test(value));
}


const retry = async (fn, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`🔁 Retry (${i + 1}/${retries})...`, err.message);
            await new Promise(res => setTimeout(res, 1000));
        }
    }
};

const sendToLLM = async (texts, language, service, doNotTranslateSet = new Set()) => {
    if (service.toLowerCase() !== 'openai') return texts;

    const nonTranslatable = Array.from(doNotTranslateSet).filter(Boolean).join(', ');

    const prompt = `
    Translate the following phrases to ${language}.

    ❗IMPORTANT❗
- Do NOT translate code snippets, technical terms, or placeholders like %s, %d.
- Do NOT translate acronyms (e.g., SQL, HTTP) or their full forms (e.g., "HyperText Transfer Protocol").
- Do NOT translate technical terms or any of these words: ${nonTranslatable}.
- Preserve escape characters like \\n, \\t, \\\" exactly as they are.
- Do not translate variable names or HTML tags (e.g., <div>, {{variable}}, etc.).
- For entries like "X - definition", ensure that "X" is translated exactly the same as the corresponding key_title (no synonyms).
- Keep each translated line in the same order.
- Only return the translations, line by line, without quotes or explanation.

    Phrases:
    ${texts.map(text => `- ${text}`).join('\n')}
        `;

    console.log("🟡 Prompt:", prompt);

    const completion = await retry(() =>
        openai.chat.completions.create({
            model: 'gpt-4o-mini-2024-07-18',
            messages: [{ role: 'user', content: prompt }],
        })
    );

    const response = completion.choices[0].message.content;
    console.log("🟢 LLM Response:", response);

    return response
        .split('\n')
        .map(text => text.trim().replace(/^[-–•]\s*/, ''))
        .filter(Boolean);
};

async function deepTranslate(obj, targetLanguage, service, translatableFields) {
    const clone = structuredClone(obj);
    const toTranslate = [];
    const paths = [];
    const globalDoNotTranslate = new Set();

    const staticTechnicalTerms = [
        'PRIMARY KEY', 'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY',
        'HTML', 'CSS', 'SQL', 'API', 'DBMS', 'JSON', 'HTTP', 'HTTPS', 'MySQL', 'int', 'varchar', 'NULL'
    ];
    staticTechnicalTerms.forEach(term => globalDoNotTranslate.add(term));

    // 🔍 Extract domain-specific words from path
    const extractTechnicalFromPath = (pathStr) => {
        return pathStr
            .split(/[\/_\-]/)
            .filter(seg => /^[a-zA-Z]{4,}$/.test(seg)) // remove short/common tokens
            .map(term => term.toLowerCase());
    };

    const domainTerms = new Set();
    if (obj.path) {
        const techTerms = extractTechnicalFromPath(obj.path);
        techTerms.forEach(term => {
            globalDoNotTranslate.add(term);
            domainTerms.add(term);
        });
    }

    const traverse = (curr, path = []) => {
        if (Array.isArray(curr)) {
            curr.forEach((item, index) => traverse(item, [...path, index]));
        } else if (isObject(curr)) {
            for (const key in curr) {
                const value = curr[key];
                const fullPath = [...path, key];

                if (key === 'highlight' && Array.isArray(value)) {
                    value.forEach(item => {
                        const term = item?.key_title?.trim();
                        if (term) {
                            globalDoNotTranslate.add(term);
                            if (item.highlight_type === "HTEXTMAIN") {
                                globalDoNotTranslate.add(term);
                            }
                            if (typeof curr.data === 'string' && curr.data.includes(term)) {
                                globalDoNotTranslate.add(term);
                            }
                        }
                    });
                }

                if (key === 'type' && value === 'HTEXTMAIN') {
                    const htextValue = curr.data?.trim();
                    if (htextValue) globalDoNotTranslate.add(htextValue);
                }

                const isFieldTranslatable = translatableFields.includes(key);
                if (isFieldTranslatable) {
                    if (key === "tap_option") continue;
                    if (key === "content" && typeof value === "string" && isCodeLikeContent(value)) {
                        console.log(`⛔ Skipping content due to code-like pattern: ${value}`);
                        continue;
                    }

                    if (typeof value === 'string') {
                        const words = value.split(/\s+/);
                        words.forEach(word => {
                            if (isAcronym(word)) globalDoNotTranslate.add(word);
                        });

                        const match = value.match(/^([^-–•]+)\s*[-–•]\s*(.+)/);
                        const isFIB = curr?.type === "FIB";

                        if (key === "content" && isFIB) {
                            const modifiedContent = value.replace(/%s/g, '###BLANK###'); // Preserve blank for FIB

                            // Exclude technical terms that shouldn't be translated
                            const excludedWords = Array.from(domainTerms).filter(term =>
                                modifiedContent.toLowerCase().includes(term.toLowerCase())
                            );

                            excludedWords.forEach(term => globalDoNotTranslate.add(term));

                            console.log("🔠 Translating FIB content:", modifiedContent);

                            paths.push({ path: fullPath, isFIB: true });
                            toTranslate.push(modifiedContent);
                        } else if (match) {
                            const [_, label, desc] = match;
                            paths.push({ path: fullPath, label: label.trim() });
                            toTranslate.push(`${label.trim()} - ${desc.trim()}`);
                        } else {
                            paths.push({ path: fullPath });
                            toTranslate.push(value);
                        }
                    } else if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
                        value.forEach((item, idx) => {
                            const words = item.split(/\s+/);
                            words.forEach(word => {
                                if (isAcronym(word)) globalDoNotTranslate.add(word);
                            });

                            const match = item.match(/^([^-–•]+)\s*[-–•]\s*(.+)/);
                            if (match) {
                                const [_, label, desc] = match;
                                paths.push({ path: [...fullPath, idx], label: label.trim() });
                                toTranslate.push(`${label.trim()} - ${desc.trim()}`);
                            } else {
                                paths.push({ path: [...fullPath, idx] });
                                toTranslate.push(item);
                            }
                        });
                    }
                }

                if (Array.isArray(value) || isObject(value)) {
                    traverse(value, fullPath);
                }
            }
        }
    };

    traverse(clone);

    const translated = await sendToLLM(toTranslate, targetLanguage, service, globalDoNotTranslate);

    paths.forEach((p, i) => {
        console.log(`🔁 [${p.label || p.path.join('.')}] ${toTranslate[i]} → ${translated[i]}`);
    });

    paths.forEach(({ path, label, isFIB }, i) => {
        let ref = clone;
        for (let j = 0; j < path.length - 1; j++) {
            ref = ref[path[j]];
        }

        let translatedVal = translated[i];

        if (isFIB) {
            translatedVal = translatedVal.replace(/###BLANK###/g, '%s'); // Reverting back to %s
        }

        if (label) {
            const [translatedLabel, translatedDesc] = translatedVal.split(/\s*[-–•]\s*/);
            const combined = translatedLabel && translatedDesc
                ? `${translatedLabel.trim()} - ${translatedDesc.trim()}`
                : translatedVal;

            ref[path[path.length - 1]] = combined;

            if (Array.isArray(ref.highlight)) {
                ref.highlight = ref.highlight.map(h => {
                    if (h.key_title === label && h.highlight_type !== "HTEXTMAIN") {
                        return {
                            ...h,
                            key_title: translatedLabel || h.key_title
                        };
                    }
                    return h;
                });
            }
        } else {
            ref[path[path.length - 1]] = translatedVal;
        }
    });

    return clone;
}



export async function translateNdjsonBatch(fileContent, targetLanguage, service) {
    const lines = fileContent.trim().split('\n');
    const translatableFields = [
        "subject", "topic_name", "data", "question_text", "correct_explanation",
        "incorrect_explanation", "option", "info_text", "rhs", "lhs",
        "key_title", "hint", "content", "description", "title", "name"
    ];

    const results = [];
    const batchSize = 5;
    const delay = (ms) => new Promise(res => setTimeout(res, ms));

    for (let i = 0; i < lines.length; i += batchSize) {
        const batch = lines.slice(i, i + batchSize);

        const translatedBatch = await Promise.all(batch.map(async (line) => {
            try {
                const obj = JSON.parse(line);
                const translatedObj = await deepTranslate(obj, targetLanguage, service, translatableFields);
                return translatedObj;
            } catch (err) {
                console.error('❌ Invalid NDJSON line:', line);
                console.error('Error:', err.message);
                return null;
            }
        }));

        results.push(...translatedBatch.filter(Boolean));

        if (i + batchSize < lines.length) {
            console.log(`⏳ Translated ${i + batchSize}/${lines.length}, waiting...`);
            await delay(1000);
        }
    }

    return results;
}

export const translateJson = async (json, language, service) => {
    const keys = Object.keys(json);
    const values = await sendToLLM(keys.map(k => json[k]), language, service);
    const result = {};
    keys.forEach((key, i) => {
        result[key] = values[i];
    });
    return result;
};

export const translateAppJson = async (json, language, service) => {
    return translateJson(json, language, service);
};

export default {
    translateNdjsonBatch,
    translateJson,
    translateAppJson
};
