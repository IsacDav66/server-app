// Archivo: server/api/chat.js
const express = require('express');
const { protect } = require('../middleware/auth');

module.exports = (pool, JWT_SECRET, io) => {
    const router = express.Router();

    // 1. OBTENER LISTA DE CONVERSACIONES (FEED DE CHATS)
    router.get('/conversations', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        try {
            const query = `
                WITH RankedMessages AS (
                    SELECT
                        m.message_id, m.sender_id, m.receiver_id, m.content, m.created_at, m.is_read,
                        CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END AS other_user_id,
                        ROW_NUMBER() OVER(
                            PARTITION BY CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END 
                            ORDER BY m.created_at DESC
                        ) as rn
                    FROM messagesapp m
                    WHERE m.sender_id = $1 OR m.receiver_id = $1
                    AND m.roomName NOT LIKE 'match_%'
                )
                SELECT
                    rm.content AS last_message_content,
                    rm.created_at AS last_message_at,
                    rm.sender_id AS last_message_sender_id,
                    rm.is_read, -- Estado de lectura del último mensaje
                    u.id AS user_id,
                    u.username,
                    u.profile_pic_url,
                    (SELECT COUNT(*)::int 
                        FROM messagesapp 
                        WHERE receiver_id = $1 
                        AND sender_id = u.id 
                        AND is_read = FALSE) AS unread_count
                FROM RankedMessages rm
                JOIN usersapp u ON rm.other_user_id = u.id
                WHERE rm.rn = 1
                ORDER BY rm.created_at DESC;
            `;
            const result = await pool.query(query, [loggedInUserId]);
            res.status(200).json({ success: true, conversations: result.rows });
        } catch (error) {
            console.error('Error conversations:', error.stack);
            res.status(500).json({ success: false });
        }
    });

    // 2. OBTENER HISTORIAL (DENTRO DEL CHAT)
    router.get('/history/:otherUserId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        const otherUserId = parseInt(req.params.otherUserId);

        try {
            // ¡CORRECCIÓN AQUÍ!: Añadimos m.is_read a la consulta
            const query = `
                SELECT 
                    m.message_id, m.sender_id, m.receiver_id, m.content, m.created_at, 
                    m.is_read, -- <--- ESTA COLUMNA FALTABA
                    m.parent_message_id,
                    m.sticker_pack,
                    m.emoji_pack,
                    p.content as parent_content,
                    pu.username as parent_username
                FROM messagesapp AS m
                LEFT JOIN messagesapp AS p ON m.parent_message_id = p.message_id
                LEFT JOIN usersapp AS pu ON p.sender_id = pu.id
                WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)
                ORDER BY m.created_at ASC;
            `;
            const result = await pool.query(query, [loggedInUserId, otherUserId]);
            res.status(200).json({ success: true, messages: result.rows });
        } catch (error) {
            console.error("Error history:", error);
            res.status(500).json({ success: false });
        }
    });

    // 3. MARCAR COMO LEÍDO
    router.post('/read-all/:senderId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const myId = req.user.userId;
        const senderId = req.params.senderId;
        try {
            // Solo marcamos como leídos los mensajes que recibí YO del OTRO
            await pool.query(
                'UPDATE messagesapp SET is_read = TRUE WHERE receiver_id = $1 AND sender_id = $2 AND is_read = FALSE',
                [myId, senderId]
            );
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false });
        }
    });

    // 4. ELIMINAR MENSAJE (CON SOCKET)
    router.delete('/messages/:messageId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        const messageId = parseInt(req.params.messageId);
        try {
            const ownership = await pool.query('SELECT sender_id, receiver_id FROM messagesapp WHERE message_id = $1', [messageId]);
            if (ownership.rows.length === 0) return res.status(404).json({ success: false });

            const msg = ownership.rows[0];
            if (msg.sender_id !== loggedInUserId) return res.status(403).json({ success: false });

            await pool.query('DELETE FROM messagesapp WHERE message_id = $1', [messageId]);

            const roomName = [msg.sender_id, msg.receiver_id].sort().join('-');
            io.to(roomName).emit('message_deleted', { messageId });
            
            res.status(200).json({ success: true });
        } catch (error) {
            res.status(500).json({ success: false });
        }
    });

    return router;
};