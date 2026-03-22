const express = require('express');
const { protect, adminOnly } = require('../middleware/auth');
const uploadBadgeMiddleware = require('../middleware/uploadBadge');
const processImage = require('../middleware/processImage');

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // Middleware de seguridad para administradores
    const checkAdmin = [
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        adminOnly(pool)
    ];

    // 1. Obtener todas las insignias creadas (Para el catálogo del admin)
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

    // 3. Asignar insignia a un usuario INDIVIDUAL (Solo Admin)
    router.post('/assign', checkAdmin, async (req, res) => {
        const { userId, badgeId } = req.body;
        try {
            // Seteamos notified = FALSE para que le salte el modal
            const result = await pool.query(
                'INSERT INTO user_badges (user_id, badge_id, notified) VALUES ($1, $2, FALSE) ON CONFLICT DO NOTHING RETURNING *', 
                [userId, badgeId]
            );

            if (result.rowCount > 0) {
                const badgeInfo = await pool.query('SELECT * FROM badges WHERE id = $1', [badgeId]);
                const io = req.app.get('socketio');
                io.to(`user-${userId}`).emit('badge_unlocked', badgeInfo.rows[0]);
            }

            res.json({ success: true, message: 'Insignia asignada' });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // 4. Crear Regla Masiva (Asignar a todos los actuales y futuros)
    router.post('/rules/create', checkAdmin, async (req, res) => {
        const { badgeId, type, endDate } = req.body; 

        try {
            await pool.query(
                'INSERT INTO badge_rules (badge_id, type, end_date) VALUES ($1, $2, $3)',
                [badgeId, type, endDate || null]
            );

            // Retroactivo: Se le da a todos los existentes con notified = FALSE
            await pool.query(`
                INSERT INTO user_badges (user_id, badge_id, notified)
                SELECT id, $1, FALSE FROM usersapp
                ON CONFLICT DO NOTHING
            `, [badgeId]);

            res.json({ success: true, message: 'Evento activado para todos.' });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // 5. Obtener reglas/eventos activos
    router.get('/rules/active', checkAdmin, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT br.*, b.name as badge_name, b.image_url 
                FROM badge_rules br 
                JOIN badges b ON br.badge_id = b.id
                ORDER BY br.created_at DESC
            `);
            res.json({ success: true, rules: result.rows });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // 6. Detener un evento
    router.delete('/rules/:id', checkAdmin, async (req, res) => {
        try {
            await pool.query('DELETE FROM badge_rules WHERE id = $1', [req.params.id]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // 7. Quitar insignia manual
    router.delete('/remove-from-user', checkAdmin, async (req, res) => {
        const { userId, badgeId } = req.body;
        try {
            await pool.query('DELETE FROM user_badges WHERE user_id = $1 AND badge_id = $2', [userId, badgeId]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // 8. Obtener insignias que el usuario aún no ha visto (notified = false)
    // CORRECCIÓN: Se envuelve el middleware protect para pasar el JWT_SECRET
    router.get('/unseen', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            const query = `
                SELECT b.id, b.name, b.image_url, ub.badge_id
                FROM user_badges ub
                JOIN badges b ON ub.badge_id = b.id
                WHERE ub.user_id = $1 AND ub.notified = FALSE
            `;
            const result = await pool.query(query, [req.user.userId]);
            res.json({ success: true, badges: result.rows });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // 9. Marcar como vistas
    // CORRECCIÓN: Se envuelve el middleware protect para pasar el JWT_SECRET
    router.post('/mark-seen', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            await pool.query('UPDATE user_badges SET notified = TRUE WHERE user_id = $1', [req.user.userId]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    return router;
};