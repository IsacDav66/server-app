const express = require('express');
const { protect, adminOnly } = require('../middleware/auth');
const uploadBadgeMiddleware = require('../middleware/uploadBadge');
const processImage = require('../middleware/processImage');

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // Middleware de seguridad para todas estas rutas
    const checkAdmin = [
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        adminOnly(pool)
    ];

    // 1. Obtener todas las insignias creadas
    router.get('/all', async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM badges ORDER BY created_at DESC');
            res.json({ success: true, badges: result.rows });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // 2. Crear una insignia (Solo Admin)
    router.post('/create', checkAdmin, uploadBadgeMiddleware, processImage('badge'), async (req, res) => {
        const { name, description } = req.body;
        if (!req.file) return res.status(400).json({ success: false, message: 'Falta la imagen' });

        const imageUrl = `/uploads/badges/${req.file.filename}`;

        try {
            const result = await pool.query(
                'INSERT INTO badges (name, description, image_url) VALUES ($1, $2, $3) RETURNING *',
                [name, description, imageUrl]
            );
            res.json({ success: true, badge: result.rows[0] });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // 3. Asignar insignia a un usuario (Solo Admin)
    router.post('/assign', checkAdmin, async (req, res) => {
        const { userId, badgeId } = req.body;
        try {
            await pool.query(
                'INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', 
                [userId, badgeId]
            );
            res.json({ success: true, message: 'Insignia asignada con éxito' });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // 4. Quitar insignia a un usuario (Solo Admin)
    router.delete('/remove-from-user', checkAdmin, async (req, res) => {
        const { userId, badgeId } = req.body;
        try {
            await pool.query('DELETE FROM user_badges WHERE user_id = $1 AND badge_id = $2', [userId, badgeId]);
            res.json({ success: true, message: 'Insignia removida' });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    return router;
};