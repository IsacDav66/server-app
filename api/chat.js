// Archivo: server/api/chat.js
const express = require('express');
const { protect } = require('../middleware/auth');
const uploadGroupPhoto = require('../middleware/uploadGroupPhoto');
const processImage = require('../middleware/processImage');

module.exports = (pool, JWT_SECRET, io) => {
    const router = express.Router();

    // 1. OBTENER LISTA DE CONVERSACIONES (FEED DE CHATS)
    router.get('/conversations', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        try {
            const query = `
                WITH CombinedMessages AS (
                    -- 1. ÚLTIMO MENSAJE DE CHATS PRIVADOS
                    (
                        SELECT DISTINCT ON (other_user_id)
                            m.message_id, m.sender_id, m.receiver_id, m.content, m.created_at, m.is_read,
                            NULL::int as group_id,
                            CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END AS other_user_id
                        FROM messagesapp m
                        WHERE (m.sender_id = $1 OR m.receiver_id = $1) 
                        AND m.group_id IS NULL
                        AND (m.room_name IS NULL OR m.room_name NOT LIKE 'match_%')
                        ORDER BY other_user_id, m.created_at DESC
                    )
                    UNION ALL
                    -- 2. ÚLTIMO MENSAJE DE GRUPOS
                    (
                        SELECT DISTINCT ON (m.group_id)
                            m.message_id, m.sender_id, NULL::int as receiver_id, m.content, m.created_at, m.is_read,
                            m.group_id,
                            NULL::int as other_user_id
                        FROM messagesapp m
                        JOIN group_members gm ON m.group_id = gm.group_id
                        WHERE gm.user_id = $1
                        ORDER BY m.group_id, m.created_at DESC
                    )
                )
                SELECT
                    cm.message_id AS last_message_id,
                    cm.content AS last_message_content,
                    cm.created_at AS last_message_at,
                    cm.sender_id AS last_message_sender_id,
                    cm.is_read AS last_message_read,
                    cm.group_id,
                    u.id AS user_id,
                    u.username,
                    u.profile_pic_url,
                    g.name AS group_name,
                    g.photo_url AS group_photo,
                    su.username AS last_msg_username, -- 🚀 NUEVO: Nombre de quien envió el último mensaje
                    -- CONTADOR DE NO LEÍDOS DINÁMICO
                    -- 🚀 NUEVA SUB-CONSULTA: Obtener hasta 5 lectores del último mensaje
                    (SELECT json_agg(json_build_object('id', r_u.id, 'avatar', r_u.profile_pic_url))
                    FROM (
                        SELECT gm.user_id
                        FROM group_members gm
                        WHERE gm.group_id = cm.group_id 
                        AND gm.last_read_message_id >= cm.message_id
                        AND gm.user_id != $1 -- No incluirme a mí mismo
                        LIMIT 5
                    ) r_ids
                    JOIN usersapp r_u ON r_u.id = r_ids.user_id
                    ) as group_readers,

                    CASE 

                        WHEN cm.group_id IS NULL THEN (
                            -- Contador para Privados (Usa el flag is_read)
                            SELECT COUNT(*)::int FROM messagesapp 
                            WHERE receiver_id = $1 AND sender_id = u.id AND is_read = FALSE AND group_id IS NULL
                        )
                        ELSE (
                            -- 🚀 CONTADOR PARA GRUPOS (Compara IDs contra tu marca en group_members)
                            SELECT COUNT(*)::int FROM messagesapp m2
                            WHERE m2.group_id = cm.group_id 
                            AND m2.sender_id != $1 
                            AND m2.message_id > (
                                SELECT COALESCE(last_read_message_id, 0) 
                                FROM group_members 
                                WHERE group_id = cm.group_id AND user_id = $1
                            )
                        )
                    END AS unread_count
                FROM CombinedMessages cm
                LEFT JOIN usersapp u ON cm.other_user_id = u.id
                LEFT JOIN groupsapp g ON cm.group_id = g.id
                LEFT JOIN usersapp su ON cm.sender_id = su.id -- 🚀 Join para traer el nombre del emisor del último mensaje
                ORDER BY cm.created_at DESC;
            `;

            const result = await pool.query(query, [loggedInUserId]);
            res.status(200).json({ success: true, conversations: result.rows });
        } catch (error) {
            console.error('❌ Error en lista de conversaciones:', error);
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

    // Obtener quién ha leído qué en un grupo
    router.get('/groups/reads/:groupId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT gm.user_id as "readerId", u.profile_pic_url as "readerAvatar", gm.last_read_message_id as "lastReadId"
                FROM group_members gm
                JOIN usersapp u ON gm.user_id = u.id
                WHERE gm.group_id = $1 AND gm.last_read_message_id > 0
            `, [req.params.groupId]);
            res.json({ success: true, reads: result.rows });
        } catch (e) { res.status(500).json({ success: false }); }
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
            // 1. Buscamos el mensaje para saber quién lo envió y a qué sala pertenece
            const result = await pool.query(
                'SELECT sender_id, room_name FROM messagesapp WHERE message_id = $1', 
                [messageId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Mensaje no encontrado' });
            }

            const msg = result.rows[0];

            // 2. Seguridad: Solo el dueño del mensaje puede borrarlo
            if (msg.sender_id !== loggedInUserId) {
                return res.status(403).json({ success: false, message: 'No tienes permiso' });
            }

            // 3. Borrar de la base de datos
            await pool.query('DELETE FROM messagesapp WHERE message_id = $1', [messageId]);

            // 🚀 4. LA CLAVE: Usamos el room_name guardado en la DB
            // Esto emitirá el evento 'message_deleted' tanto a salas 'ID-ID' como a 'group_ID'
            io.to(msg.room_name).emit('message_deleted', { messageId });
            
            res.status(200).json({ success: true });

        } catch (error) {
            console.error('Error al eliminar mensaje:', error);
            res.status(500).json({ success: false });
        }
    });



    router.post('/groups/create', (req, res, next) => protect(req, res, next, JWT_SECRET), uploadGroupPhoto, processImage('group'), async (req, res) => {
        const { name, description, members } = req.body;
        const creatorId = req.user.userId;
        const memberIds = JSON.parse(members);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Obtener nombre del creador para el mensaje automático
            const creatorRes = await client.query('SELECT username FROM usersapp WHERE id = $1', [creatorId]);
            const creatorName = creatorRes.rows[0].username;

            // 2. Insertar el Grupo
            const photoPath = req.file ? `/uploads/group_photos/${req.file.filename}` : 'default-group';
            const groupRes = await client.query(
                `INSERT INTO groupsapp (name, description, creator_id, photo_url) 
                VALUES ($1, $2, $3, $4) RETURNING id`,
                [name, description, creatorId, photoPath]
            );
            const groupId = groupRes.rows[0].id;
            const roomName = `group_${groupId}`;

            // 3. Insertar Miembros
            const allMembers = [...new Set([creatorId, ...memberIds])];
            for (const uId of allMembers) {
                await client.query(
                    'INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3)',
                    [groupId, uId, uId === creatorId ? 'admin' : 'member']
                );
            }

            // 🚀 4. MENSAJE AUTOMÁTICO DE CREACIÓN
            // Insertamos el mensaje como si lo enviara el creador o el sistema
            const systemMsg = `🚀 ¡Tripulación creada! Bienvenidos a ${name}.`;
            const msgResult = await client.query(
                `INSERT INTO messagesapp (sender_id, group_id, content, room_name) 
                VALUES ($1, $2, $3, $4) RETURNING *`,
                [creatorId, groupId, systemMsg, roomName]
            );

            await client.query('COMMIT');

            // 📡 5. NOTIFICAR POR SOCKET EN TIEMPO REAL
            // Esto hace que el grupo aparezca en la lista de los que están online
            const io = req.app.get('socketio');
            const savedMessage = msgResult.rows[0];
            savedMessage.username = creatorName; // Adjuntar nombre para la lista de chats

            // Forzar a que el creador se una a la sala de inmediato si no lo estaba
            const userSockets = await io.fetchSockets();
            allMembers.forEach(mId => {
                const memberSocket = userSockets.find(s => String(s.userId) === String(mId));
                if (memberSocket) memberSocket.join(roomName);
            });

            // Emitir a la sala del grupo
            io.to(roomName).emit('receive_message', savedMessage);

            res.json({ success: true, groupId });

        } catch (e) {
            await client.query('ROLLBACK');
            console.error("Error al crear grupo:", e);
            res.status(500).json({ success: false, message: e.message });
        } finally {
            client.release();
        }
    });

    // OBTENER DETALLES COMPLETOS DE UN GRUPO
    router.get('/groups/details/:groupId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const groupId = req.params.groupId;
        const myId = req.user.userId;

        try {
            // 1. Info del Grupo
            const groupInfo = await pool.query('SELECT * FROM groupsapp WHERE id = $1', [groupId]);
            
            // 2. Miembros con su rol y foto
            const members = await pool.query(`
                SELECT u.id, u.username, u.profile_pic_url, gm.role, u.is_online
                FROM group_members gm
                JOIN usersapp u ON gm.user_id = u.id
                WHERE gm.group_id = $1
                ORDER BY (CASE WHEN gm.role = 'admin' THEN 1 ELSE 2 END) ASC
            `, [groupId]);

            // 3. Media compartida (Buscamos mensajes que tengan el tag [MEDIA_)
            const media = await pool.query(`
                SELECT content FROM messagesapp 
                WHERE group_id = $1 AND content LIKE '%[MEDIA_%' 
                ORDER BY created_at DESC LIMIT 8
            `, [groupId]);

            res.json({
                success: true,
                group: groupInfo.rows[0],
                members: members.rows,
                media: media.rows,
                isAdmin: members.rows.find(m => m.id === myId)?.role === 'admin'
            });
        } catch (e) { res.status(500).json({ success: false }); }
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