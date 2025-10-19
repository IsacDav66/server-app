// Archivo: server/api/chat.js
const express = require('express');
const { protect } = require('../middleware/auth');

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // Ruta para obtener el historial de mensajes entre dos usuarios
    router.get('/history/:otherUserId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        const otherUserId = parseInt(req.params.otherUserId);

        if (isNaN(otherUserId)) {
            return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });
        }

        try {
            const query = `
                SELECT * FROM messagesapp
                WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
                ORDER BY created_at ASC;
            `;
            const result = await pool.query(query, [loggedInUserId, otherUserId]);
            res.status(200).json({ success: true, messages: result.rows });
        } catch (error) {
            console.error("Error al obtener el historial del chat:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    return router;
};