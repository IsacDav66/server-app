// Archivo: server/api/chat.js
const express = require('express');
const { protect } = require('../middleware/auth');
const multer = require('multer'); // 🚀 Importa multer directamente
// Configura un "upload" local para esta ruta
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

module.exports = (pool, JWT_SECRET, io) => {
    const router = express.Router();

    // 1. OBTENER LISTA DE CONVERSACIONES (FEED DE CHATS)
    router.get('/conversations', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        try {
            const query = `
                WITH CombinedMessages AS (
                    -- Chats Privados
                    SELECT DISTINCT ON (CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END)
                        m.message_id, m.sender_id, m.receiver_id, m.content, m.created_at, m.is_read, m.room_name,
                        NULL::int as group_id,
                        CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END AS other_user_id
                    FROM messagesapp m
                    WHERE (m.sender_id = $1 OR m.receiver_id = $1) AND m.group_id IS NULL
                    AND (m.room_name IS NULL OR m.room_name NOT LIKE 'match_%')
                    ORDER BY CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END, m.created_at DESC

                    UNION ALL

                    -- Chats de Grupos
                    SELECT DISTINCT ON (m.group_id)
                        m.message_id, m.sender_id, NULL::int as receiver_id, m.content, m.created_at, m.is_read, m.room_name,
                        m.group_id,
                        NULL::int as other_user_id
                    FROM messagesapp m
                    JOIN group_members gm ON m.group_id = gm.group_id
                    WHERE gm.user_id = $1
                    ORDER BY m.group_id, m.created_at DESC
                )
                SELECT 
                    cm.*,
                    u.username, u.profile_pic_url,
                    g.name as group_name, g.photo_url as group_photo,
                    (SELECT COUNT(*)::int FROM messagesapp 
                     WHERE (receiver_id = $1 AND sender_id = u.id AND is_read = FALSE)
                     OR (group_id = cm.group_id AND sender_id != $1 AND is_read = FALSE)
                    ) AS unread_count
                FROM CombinedMessages cm
                LEFT JOIN usersapp u ON cm.other_user_id = u.id
                LEFT JOIN groupsapp g ON cm.group_id = g.id
                ORDER BY cm.created_at DESC;
            `;
            const result = await pool.query(query, [loggedInUserId]);
            res.status(200).json({ success: true, conversations: result.rows });
        } catch (error) {
            console.error('Error conversations:', error);
            res.status(500).json({ success: false });
        }
    });

    // 2. OBTENER HISTORIAL (DENTRO DEL CHAT)
    router.get('/history/:otherUserId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        const otherUserId = parseInt(req.params.otherUserId);
        
        // 1. Obtener paginación de la query string (por defecto 100)
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;

        try {
            // 2. Modificamos la query para usar LIMIT y OFFSET
            // IMPORTANTE: Ordenamos por DESC para traer los ULTIMOS 100 primero
            const query = `
                SELECT 
                    m.message_id, m.sender_id, m.receiver_id, m.content, m.created_at, 
                    m.is_read, m.parent_message_id, m.sticker_pack, m.emoji_pack,
                    p.content as parent_content,
                    pu.username as parent_username
                FROM messagesapp AS m
                LEFT JOIN messagesapp AS p ON m.parent_message_id = p.message_id
                LEFT JOIN usersapp AS pu ON p.sender_id = pu.id
                WHERE (m.sender_id = $1 AND m.receiver_id = $2) 
                OR (m.sender_id = $2 AND m.receiver_id = $1)
                ORDER BY m.created_at DESC -- Traer los más nuevos primero
                LIMIT $3 OFFSET $4;
            `;
            const result = await pool.query(query, [loggedInUserId, otherUserId, limit, offset]);
            
            // 3. Los devolvemos al revés (ASC) para que el frontend los dibuje en orden cronológico
            const messages = result.rows.reverse();
            
            res.status(200).json({ 
                success: true, 
                messages: messages,
                hasMore: result.rows.length === limit // Si trajo 100, es probable que haya más
            });
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




    // NUEVO: CREAR GRUPO
    const upload = require('../middleware/upload'); // Asegúrate de tener tu multer configurado

    router.post('/groups/create', (req, res, next) => protect(req, res, next, JWT_SECRET), upload.single('groupPhoto'), async (req, res) => {
        const { name, description, members } = req.body; // members es un string JSON "[1,2,3]"
        const creatorId = req.user.userId;
        const memberIds = JSON.parse(members);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Insertar Grupo
            const groupRes = await client.query(
                `INSERT INTO groupsapp (name, description, creator_id, photo_url) 
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [name, description, creatorId, req.file ? `/uploads/group_photos/${req.file.filename}` : '/assets/img/default-group.png']
            );
            const groupId = groupRes.rows[0].id;

            // 2. Insertar Miembros (incluyendo al creador)
            const allMembers = [...new Set([creatorId, ...memberIds])];
            for (const uId of allMembers) {
                await client.query(
                    'INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)',
                    [groupId, uId, uId === creatorId ? 'admin' : 'member']
                );
            }

            await client.query('COMMIT');
            res.json({ success: true, groupId });
        } catch (e) {
            await client.query('ROLLBACK');
            res.status(500).json({ success: false, message: e.message });
        } finally {
            client.release();
        }
    });



    // NUEVO: OBTENER HISTORIAL DE GRUPO
    router.get('/history/group/:groupId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const groupId = parseInt(req.params.groupId);
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;

        try {
            const query = `
                SELECT 
                    m.message_id, m.sender_id, m.content, m.created_at, m.group_id,
                    m.parent_message_id, m.sticker_pack, m.emoji_pack,
                    u.username, u.profile_pic_url,
                    p.content as parent_content,
                    pu.username as parent_username
                FROM messagesapp m
                JOIN usersapp u ON m.sender_id = u.id
                LEFT JOIN messagesapp p ON m.parent_message_id = p.message_id
                LEFT JOIN usersapp pu ON p.sender_id = pu.id
                WHERE m.group_id = $1
                ORDER BY m.created_at DESC
                LIMIT $2 OFFSET $3;
            `;
            const result = await pool.query(query, [groupId, limit, offset]);
            res.json({ 
                success: true, 
                messages: result.rows.reverse(), 
                hasMore: result.rows.length === limit 
            });
        } catch (error) {
            res.status(500).json({ success: false });
        }
    });
    
    // RUTA PARA INFO DEL CABEZAL DEL CHAT (Nombre y foto del grupo)
    router.get('/groups/info/:groupId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            const resGroup = await pool.query('SELECT name, photo_url FROM groupsapp WHERE id = $1', [req.params.groupId]);
            res.json({ success: true, group: resGroup.rows[0] });
        } catch (e) { res.status(500).json({ success: false }); }
    });


    return router;
};