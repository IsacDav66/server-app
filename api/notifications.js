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


    // RUTA PARA MARCAR LEÍDA UNA NOTIFICACIÓN ESPECÍFICA O TODAS LAS DE UN CHAT
    router.post('/read-specific', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { notificationId, senderId, type } = req.body;
        const recipientId = req.user.userId;

        try {
            if (notificationId) {
                // Caso 1: Marcar una sola (ej. un seguidor nuevo)
                await pool.query(
                    'UPDATE notificationsapp SET is_read = TRUE WHERE notification_id = $1 AND recipient_id = $2',
                    [notificationId, recipientId]
                );
            } else if (senderId && type) {
                // Caso 2: Marcar todas las de un emisor (ej. al entrar al chat)
                await pool.query(
                    'UPDATE notificationsapp SET is_read = TRUE WHERE recipient_id = $1 AND sender_id = $2 AND type = $3',
                    [recipientId, senderId, type]
                );
            }
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false });
        }
    });

    return router;
};