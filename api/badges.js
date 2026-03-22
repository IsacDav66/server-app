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

    // 3. Asignar insignia a un usuario INDIVIDUAL (Solo Admin)
    router.post('/assign', checkAdmin, async (req, res) => {
        const { userId, badgeId } = req.body;
        try {
            const result = await pool.query(
                'INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *', 
                [userId, badgeId]
            );

            if (result.rowCount > 0) {
                // Buscamos los datos de la insignia para el socket
                const badgeInfo = await pool.query('SELECT * FROM badges WHERE id = $1', [badgeId]);
                
                // Enviamos el aviso por Socket.io
                const io = req.app.get('socketio');
                io.to(`user-${userId}`).emit('badge_unlocked', badgeInfo.rows[0]);
            }

            res.json({ success: true, message: 'Insignia asignada' });
        } catch (e) {
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // ============================================================
    // === NUEVAS RUTAS DE ASIGNACIÓN MASIVA (EVENTOS) ===
    // ============================================================

    // 4. Crear Regla Masiva (Asignar a todos los actuales y futuros)
    router.post('/rules/create', checkAdmin, async (req, res) => {
        const { badgeId, type, endDate } = req.body; 
        // type: 'global_indefinite' o 'global_limited'

        try {
            // A. Guardamos la regla para los usuarios que se registren en el futuro
            await pool.query(
                'INSERT INTO badge_rules (badge_id, type, end_date) VALUES ($1, $2, $3)',
                [badgeId, type, endDate || null]
            );

            // B. Asignamos la insignia a TODOS los usuarios que ya existen actualmente
            // (Retroactivo: los que ya tienen cuenta también la reciben)
            await pool.query(`
                INSERT INTO user_badges (user_id, badge_id)
                SELECT id, $1 FROM usersapp
                ON CONFLICT DO NOTHING
            `, [badgeId]);

            res.json({ success: true, message: 'Evento activado: Todos los usuarios actuales han recibido la insignia y los nuevos la recibirán al unirse.' });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false, message: e.message });
        }
    });

    // 5. Obtener reglas/eventos de insignias activos
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

    // 6. Detener un evento (Borrar regla)
    // Nota: Esto solo detiene que se les asigne a los NUEVOS. 
    // Los que ya la tienen NO la pierden (como pediste).
    router.delete('/rules/:id', checkAdmin, async (req, res) => {
        try {
            await pool.query('DELETE FROM badge_rules WHERE id = $1', [req.params.id]);
            res.json({ success: true, message: 'Evento finalizado. Los usuarios conservan su insignia.' });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // ============================================================

    // 7. Quitar insignia a un usuario (Solo Admin - Manual)
    router.delete('/remove-from-user', checkAdmin, async (req, res) => {
        const { userId, badgeId } = req.body;
        try {
            await pool.query('DELETE FROM user_badges WHERE user_id = $1 AND badge_id = $2', [userId, badgeId]);
            res.json({ success: true, message: 'Insignia removida' });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    // Obtener insignias que el usuario aún no ha visto (notified = false)
    router.get('/unseen', protect, async (req, res) => {
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

    // Marcar como vistas
    router.post('/mark-seen', protect, async (req, res) => {
        try {
            await pool.query('UPDATE user_badges SET notified = TRUE WHERE user_id = $1', [req.user.userId]);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ success: false });
        }
    });

    return router;
};