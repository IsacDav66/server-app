// /server/api/notifications.js
const express = require('express');
const { protect } = require('../middleware/auth');

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // RUTA PARA OBTENER TODAS LAS NOTIFICACIONES DE UN USUARIO
    router.get('/', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const recipientId = req.user.userId;
        try {
            const query = `
                SELECT n.*, u.username AS sender_username, u.profile_pic_url AS sender_profile_pic_url
                FROM notificationsapp n
                JOIN usersapp u ON n.sender_id = u.id
                WHERE n.recipient_id = $1
                ORDER BY n.created_at DESC
                LIMIT 30;
            `;
            const result = await pool.query(query, [recipientId]);
            res.status(200).json({ success: true, notifications: result.rows });
        } catch (error) {
            console.error('Error al obtener notificaciones:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // RUTA PARA MARCAR TODAS LAS NOTIFICACIONES COMO LEÍDAS
    router.post('/mark-read', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const recipientId = req.user.userId;
        try {
            const query = 'UPDATE notificationsapp SET is_read = TRUE WHERE recipient_id = $1';
            await pool.query(query, [recipientId]);
            res.status(200).json({ success: true, message: 'Notificaciones marcadas como leídas.' });
        } catch (error) {
            console.error('Error al marcar notificaciones como leídas:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    return router;
};