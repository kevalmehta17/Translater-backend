import express from 'express';
import cors from 'cors';
import translationRoutes from './Controller/translation.controller.js';

const app = express();
const PORT = 5000;

app.use(cors({
    origin: ['http://localhost:3000', 'https://translater-hackerx-frontend-gzxb6nl4qq-uc.a.run.app', 'https://translater-hackerx-gzxb6nl4qq-el.a.run.app'],
    credentials: true,
}));
app.use(express.json());

app.use('/api/translate', translationRoutes);

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
