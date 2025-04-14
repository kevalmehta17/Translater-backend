import express from 'express';
import multer from 'multer';
import fs from 'fs';
import archiver from 'archiver';
import { translateJson, translateNdjsonBatch, translateAppJson } from '../service/translationservice.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/translate/single
router.post('/single', upload.single('file'), async (req, res) => {
    const { language, service, fileType = 'json' } = req.body;

    try {
        // This file converts the file buffer to a string
        const fileBuffer = req.file.buffer;
        const fileContent = fileBuffer.toString('utf-8');

        // Check the file type and process accordingly First For the ndjosn file
        if (fileType.toLowerCase() === 'ndjson') {
            const result = await translateNdjsonBatch(fileContent, language, service);
            return res.json(result);
        } else {
            // For the json file
            const jsonContent = JSON.parse(fileContent);
            const result = await translateJson(jsonContent, language, service);
            return res.json(result);
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error processing single file' });
    }
});

// POST /api/translate/app-json
// Here The uploaded file is expected to be a JSON with string key-value pairs 
router.post('/app-json', upload.single('file'), async (req, res) => {
    const { language, service } = req.body;

    try {
        const fileBuffer = req.file.buffer;
        const jsonContent = JSON.parse(fileBuffer.toString('utf-8'));

        const result = await translateAppJson(jsonContent, language, service);
        return res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error processing app JSON file' });
    }
});

// POST /api/translate/multiple
router.post('/multiple', upload.array('files'), async (req, res) => {
    const { language, service, fileType = 'json' } = req.body;
    const zipPath = 'translated_files.zip';
    const archive = archiver('zip');
    const output = fs.createWriteStream(zipPath);

    archive.pipe(output);

    try {
        for (const file of req.files) {
            const fileContent = file.buffer.toString('utf-8');
            const fileName = file.originalname;

            if (fileType.toLowerCase() === 'ndjson') {
                const result = await translateNdjsonBatch(fileContent, language, service);
                const ndjson = result.map(obj => JSON.stringify(obj)).join('\n');
                archive.append(ndjson, { name: fileName });
            } else {
                const jsonContent = JSON.parse(fileContent);
                const result = await translateJson(jsonContent, language, service);
                archive.append(JSON.stringify(result, null, 2), { name: fileName });
            }
        }

        await archive.finalize();
        output.on('close', () => {
            res.download(zipPath, () => fs.unlinkSync(zipPath));
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error processing multiple files' });
    }
});

export default router;
