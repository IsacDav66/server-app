// Archivo: server/api/chat.js
const express = require('express');
const { protect } = require('../middleware/auth');
const uploadGroupPhoto = require('../middleware/uploadGroupPhoto');
const uploadRoleIcon = require('../middleware/uploadRoleIcon'); // 🚀 NUEVA IMPORTACIÓN

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
                        AND NOT ($1 = ANY(COALESCE(m.hidden_by, '{}')))
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
                        AND NOT ($1 = ANY(COALESCE(m.hidden_by, '{}')))
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
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;

        try {
            const query = `
                SELECT 
                    m.*, u.username, u.profile_pic_url,
                    p.content as parent_content,
                    pu.username as parent_username,
                    p.sender_id as parent_author_id,
                    
                    -- 🌈 COLOR DEL AUTOR (En privado usamos el color base o un fallback)
                    'var(--color-accent)' as author_color, 
                    'var(--color-accent)' as parent_author_color
                    
                FROM messagesapp AS m
                JOIN usersapp AS u ON m.sender_id = u.id
                LEFT JOIN messagesapp AS p ON m.parent_message_id = p.message_id
                LEFT JOIN usersapp AS pu ON p.sender_id = pu.id
                WHERE ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1))
                AND m.group_id IS NULL
                AND NOT ($1 = ANY(COALESCE(m.hidden_by, '{}')))
                ORDER BY m.created_at DESC
                LIMIT $3 OFFSET $4;
            `;
            
            const result = await pool.query(query, [loggedInUserId, otherUserId, limit, offset]);
            
            res.status(200).json({ 
                success: true, 
                messages: result.rows.reverse(),
                hasMore: result.rows.length === limit 
            });
        } catch (error) {
            console.error("❌ Error en historial privado:", error.message);
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

            // 🚀 CREAR ROL POR DEFECTO AUTOMÁTICAMENTE
            const defaultPermissions = {
                can_send_messages: true, can_send_photos: true, can_send_voice: true,
                can_use_emojis: true, can_use_stickers: true, can_use_music: true,
                can_add_members: false, can_invite: false, is_admin: false
            };

            await client.query(
                `INSERT INTO group_roles (group_id, name, permissions, color, is_default, display_order) 
                VALUES ($1, $2, $3, $4, $5, 1000)`,
                [groupId, 'Miembro', defaultPermissions, '#95a5a6', true]
            );
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
    // 🚀 RUTA PARA AÑADIR MIEMBROS A UN GRUPO EXISTENTE
    // 🚀 RUTA PARA AÑADIR MIEMBROS A UN GRUPO EXISTENTE
    router.post('/groups/add-members', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { groupId, memberIds } = req.body; 
        const myId = req.user.userId;

        try {
            // 1. Verificar Seguridad
            const checkAdmin = await pool.query(
                'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
                [groupId, myId]
            );

            if (checkAdmin.rows.length === 0 || checkAdmin.rows[0].role !== 'admin') {
                return res.status(403).json({ success: false, message: "Solo el administrador puede reclutar miembros." });
            }

            // 2. Insertar a los nuevos integrantes en la DB
            for (const uId of memberIds) {
                await pool.query(
                    'INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                    [groupId, uId, 'member']
                );
            }

            // 3. Obtener nombres para el mensaje de sistema
            const idsToSearch = [myId, ...memberIds];
            const namesRes = await pool.query('SELECT id, username FROM usersapp WHERE id = ANY($1)', [idsToSearch]);
            
            const adminRow = namesRes.rows.find(u => String(u.id) === String(myId));
            const adminName = adminRow ? adminRow.username : "El Capitán";
            const recruitedUsers = namesRes.rows.filter(u => String(u.id) !== String(myId));
            const newNames = recruitedUsers.map(u => u.username).join(', ');

            const systemMsg = `🚀 ${adminName} reclutó a: ${newNames || "nuevos miembros"}.`;
            
            // 4. Guardar mensaje en la DB
            const msgResult = await pool.query(
                `INSERT INTO messagesapp (sender_id, group_id, content, room_name) 
                VALUES ($1, $2, $3, $4) RETURNING *`,
                [myId, groupId, systemMsg, `group_${groupId}`]
            );

            const savedMsg = msgResult.rows[0];
            savedMsg.username = adminName; // Importante para la UI

            // 📡 --- LÓGICA DE SOCKETS MEJORADA ---
            const io = req.app.get('socketio');
            const roomName = `group_${groupId}`;
            const allSockets = await io.fetchSockets();
            
            // A. Forzar a los nuevos usuarios a unirse a la sala del grupo
            memberIds.forEach(mId => {
                const memberSockets = allSockets.filter(s => String(s.userId) === String(mId));
                memberSockets.forEach(s => {
                    s.join(roomName);
                });

                // B. ENVIAR DIRECTAMENTE A LA SALA PERSONAL DEL NUEVO USUARIO
                // Esto garantiza que el mensaje aparezca en su lista de chats (chat_list.html)
                // aunque el proceso de s.join(roomName) sea lento.
                io.to(`user-${mId}`).emit('receive_message', savedMsg);
            });

            // C. Enviar a los que ya estaban en el grupo
            io.to(roomName).emit('receive_message', savedMsg);

            res.json({ success: true, message: "Miembros reclutados con éxito." });

        } catch (error) {
            console.error("❌ Error al añadir miembros:", error);
            res.status(500).json({ success: false, message: "Error interno del servidor." });
        }
    });

    // OBTENER DETALLES COMPLETOS DE UN GRUPO (VERSIÓN CORREGIDA)
    // OBTENER DETALLES COMPLETOS DE UN GRUPO (VERSIÓN DISCORD-PRO)
    router.get('/groups/details/:groupId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const groupId = req.params.groupId;
        const myId = req.user.userId;

        try {
            const groupRes = await pool.query('SELECT * FROM groupsapp WHERE id = $1', [groupId]);
            if (groupRes.rows.length === 0) return res.status(404).json({ success: false, message: "Grupo no encontrado" });

            const membersRes = await pool.query(`
                SELECT u.id, u.username, u.profile_pic_url, gm.role,
                    -- 🌈 1. COLOR DEL NOMBRE (Mantiene tu jerarquía actual)
                    (SELECT r2.color 
                        FROM member_roles_link mrl2
                        JOIN group_roles r2 ON mrl2.role_id = r2.id
                        WHERE mrl2.user_id = u.id AND mrl2.group_id = $1
                        ORDER BY 
                            r2.display_order ASC, 
                            (r2.permissions->>'is_admin')::boolean DESC,
                            (r2.permissions->>'can_mute')::boolean DESC,
                            (r2.permissions->>'can_add_members')::boolean DESC,
                            r2.id DESC   -- 👈 EL ÚLTIMO QUE SE PUSO GANA
                        LIMIT 1) as name_color,

                    -- 🛡️ 2. ICONO DEL ROL (Usa la misma jerarquía exacta para que coincidan)
                    (SELECT r2.icon_url 
                        FROM member_roles_link mrl2
                        JOIN group_roles r2 ON mrl2.role_id = r2.id
                        WHERE mrl2.user_id = u.id AND mrl2.group_id = $1
                        ORDER BY 
                            r2.display_order ASC, 
                            (r2.permissions->>'is_admin')::boolean DESC,
                            (r2.permissions->>'can_mute')::boolean DESC,
                            r2.id DESC
                        LIMIT 1) as role_icon,

                    -- 🎭 3. ARRAY DE ROLES (Añadimos el icono al objeto JSON de cada rol)
                    COALESCE(
                        (SELECT json_agg(json_build_object(
                            'id', r3.id, 
                            'name', r3.name, 
                            'color', r3.color, 
                            'icon', r3.icon_url, -- 👈 Añadir esto
                            'permissions', r3.permissions,
                            'display_order', r3.display_order -- 👈 IMPORTANTE: Mandar el orden al Front
                        ) ORDER BY r3.display_order ASC)
                        FROM member_roles_link mrl3
                        JOIN group_roles r3 ON mrl3.role_id = r3.id
                        WHERE mrl3.user_id = u.id AND mrl3.group_id = $1),
                        '[]'::json
                    ) as roles

                FROM group_members gm
                JOIN usersapp u ON gm.user_id = u.id
                WHERE gm.group_id = $1
                GROUP BY u.id, gm.role
                ORDER BY (CASE WHEN gm.role = 'admin' THEN 1 ELSE 2 END) ASC, u.username ASC
            `, [groupId]);
            
            // Lógica Live (Socket status)
            const onlineUsers = req.app.get('onlineUsers'); 
            const onlineIds = new Set(Array.from(onlineUsers.values()).map(u => u.userId));

            const membersWithStatus = membersRes.rows.map(m => ({
                ...m,
                is_online: onlineIds.has(m.id)
            }));

            // Media compartida
            const mediaRes = await pool.query(`
                SELECT content FROM messagesapp 
                WHERE group_id = $1 
                AND (
                    content LIKE '%[MEDIA_IMAGE:%' OR 
                    content LIKE '%[MEDIA_VIDEO:%' OR 
                    content LIKE '%[MEDIA_GIF:%' OR 
                    content LIKE '%[MEDIA_GRID:%'
                ) 
                ORDER BY created_at DESC LIMIT 30
            `, [groupId]);

            let allMediaItems = [];

            mediaRes.rows.forEach(m => {
                const raw = m.content;
                
                if (raw.includes('[MEDIA_GRID:')) {
                    const gridContent = raw.match(/\[MEDIA_GRID:(.*?)\]/);
                    if (gridContent) {
                        const items = gridContent[1].split('_I_');
                        items.forEach(itemStr => {
                            const p = itemStr.split('_P_');
                            // 🚀 FILTRO: Solo añadimos si NO es AUDIO
                            if (p[1] !== 'AUDIO') {
                                allMediaItems.push({ id: p[0], type: p[1], lq: p[2] || "" });
                            }
                        });
                    }
                } else {
                    const typeMatch = raw.match(/\[MEDIA_(.*?):/);
                    if (!typeMatch) return;
                    const type = typeMatch[1];
                    
                    // 🚀 FILTRO: Ignorar mensajes individuales de AUDIO
                    if (type === 'AUDIO') return;

                    const inner = raw.substring(raw.indexOf(':') + 1, raw.lastIndexOf(']'));
                    const p = inner.split('_P_');
                    
                    let id = p[0];
                    let lq = (type === 'VIDEO' || type === 'GIF') ? p[2] : p[1];
                    allMediaItems.push({ id, type, lq: lq || "" });
                }
            });

            // 🔥 LOG FORZADO (Este aparecerá sí o sí si hay media)
            console.log(`📸 [GALERÍA] Se procesaron ${allMediaItems.length} miniaturas.`);

            res.json({
                success: true,
                group: groupRes.rows[0],
                members: membersWithStatus,
                media: allMediaItems, 
                isAdmin: membersRes.rows.find(m => m.id === myId)?.role === 'admin'
            });
        } catch (error) {
            console.error("❌ ERROR EN DETAILS GRUPO:", error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // NUEVO: OBTENER HISTORIAL DE GRUPO
    router.get('/history/group/:groupId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const groupId = parseInt(req.params.groupId);
        const myId = req.user.userId; // 🚀 Obtenemos tu ID para filtrar
        const limit = parseInt(req.query.limit) || 100;
        const offset = parseInt(req.query.offset) || 0;

        try {
            const query = `
                SELECT 
                    m.*, u.username, u.profile_pic_url,
                    p.content as parent_content,
                    pu.username as parent_username,
                    p.sender_id as parent_author_id,

                    -- COLOR E ICONO DEL AUTOR
                    (SELECT r.color FROM member_roles_link mrl
                     JOIN group_roles r ON mrl.role_id = r.id
                     WHERE mrl.user_id = m.sender_id AND mrl.group_id = m.group_id
                     ORDER BY r.display_order ASC, r.id DESC LIMIT 1) as author_color,

                    (SELECT r.icon_url FROM member_roles_link mrl
                     JOIN group_roles r ON mrl.role_id = r.id
                     WHERE mrl.user_id = m.sender_id AND mrl.group_id = m.group_id
                     ORDER BY r.display_order ASC, r.id DESC LIMIT 1) as author_icon,

                    -- COLOR E ICONO DEL AUTOR CITADO (PADRE)
                    (SELECT r_p.color FROM member_roles_link mrl_p
                     JOIN group_roles r_p ON mrl_p.role_id = r_p.id
                     WHERE mrl_p.user_id = p.sender_id AND mrl_p.group_id = m.group_id
                     ORDER BY r_p.display_order ASC, r_p.id DESC LIMIT 1) as parent_author_color,

                    (SELECT r_p.icon_url FROM member_roles_link mrl_p
                     JOIN group_roles r_p ON mrl_p.role_id = r_p.id
                     WHERE mrl_p.user_id = p.sender_id AND mrl_p.group_id = m.group_id
                     ORDER BY r_p.display_order ASC, r_p.id DESC LIMIT 1) as parent_author_icon

                FROM messagesapp m
                JOIN usersapp u ON m.sender_id = u.id
                LEFT JOIN messagesapp p ON m.parent_message_id = p.message_id
                LEFT JOIN usersapp pu ON p.sender_id = pu.id
                WHERE m.group_id = $1
                -- 🚀 FILTRO DE PRIVACIDAD CORREGIDO ($4)
                AND NOT ($4 = ANY(COALESCE(m.hidden_by, '{}')))
                ORDER BY m.created_at DESC
                LIMIT $2 OFFSET $3;
            `;

            // 🚀 IMPORTANTE: Pasamos 4 parámetros: groupId, limit, offset y myId
            const result = await pool.query(query, [groupId, limit, offset, myId]);
            
            res.json({ 
                success: true, 
                messages: result.rows.reverse(), 
                hasMore: result.rows.length === limit 
            });
        } catch (error) {
            console.error("❌ Error cargando historial de grupo:", error.message);
            res.status(500).json({ success: false });
        }
    });
    
    // RUTA PARA INFO DEL CABEZAL DEL CHAT (Nombre y foto del grupo)
    router.get('/groups/info/:groupId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            // 🚀 SQL para obtener info + conteo de miembros
            const query = `
                SELECT g.name, g.photo_url, 
                (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
                FROM groupsapp g WHERE g.id = $1
            `;
            const resGroup = await pool.query(query, [req.params.groupId]);
            
            if (resGroup.rows.length > 0) {
                res.json({ success: true, group: resGroup.rows[0] });
            } else {
                res.status(404).json({ success: false });
            }
        } catch (e) { res.status(500).json({ success: false }); }
    });


    router.get('/media/private/:otherUserId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const myId = req.user.userId;
        const otherId = parseInt(req.params.otherUserId);

        try {
            // 1. Buscamos mensajes que contengan media entre tú y el otro usuario
            const result = await pool.query(`
                SELECT content FROM messagesapp 
                WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
                AND group_id IS NULL
                AND NOT ($1 = ANY(COALESCE(hidden_by, '{}'))) 
                AND (content LIKE '%[MEDIA_%' OR content LIKE '%[MEDIA_GRID:%')
                ORDER BY created_at DESC LIMIT 30
            `, [myId, otherId]);

            let allMediaItems = [];

            // 2. Procesamos el texto de los mensajes para extraer los objetos de imagen/video
            result.rows.forEach(m => {
                const raw = m.content;
                
                if (raw.includes('[MEDIA_GRID:')) {
                    const gridContent = raw.match(/\[MEDIA_GRID:(.*?)\]/);
                    if (gridContent) {
                        const items = gridContent[1].split('_I_');
                        items.forEach(itemStr => {
                            const p = itemStr.split('_P_');
                            if (p[1] !== 'AUDIO') {
                                allMediaItems.push({ id: p[0], type: p[1], lq: p[2] || "" });
                            }
                        });
                    }
                } else {
                    const typeMatch = raw.match(/\[MEDIA_(.*?):/);
                    if (!typeMatch) return;
                    const type = typeMatch[1];
                    if (type === 'AUDIO') return;

                    const inner = raw.substring(raw.indexOf(':') + 1, raw.lastIndexOf(']'));
                    const p = inner.split('_P_');
                    
                    let id = p[0];
                    let lq = (type === 'VIDEO' || type === 'GIF') ? p[2] : p[1];
                    allMediaItems.push({ id, type, lq: lq || "" });
                }
            });

            res.json({ success: true, media: allMediaItems });

        } catch (e) {
            console.error("❌ Error en media/private:", e.message);
            res.status(500).json({ success: false });
        }
    });


    // --- 🚀 RUTA: ELIMINAR CHAT PRIVADO ---
    router.delete('/private/:otherUserId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const myId = req.user.userId;
        const otherId = parseInt(req.params.otherUserId);
        const { deleteForBoth } = req.query;
        const roomName = [myId, otherId].sort((a, b) => a - b).join('-');

        try {
            if (deleteForBoth === 'true') {
                // Ejecutamos el borrado
                await pool.query('DELETE FROM messagesapp WHERE room_name = $1', [roomName]);
                
                // 🚀 Enviar aviso por socket (sin await para no bloquear la respuesta HTTP)
                const io = req.app.get('socketio');
                if (io) io.to(roomName).emit('chat_cleared', { deletedBy: myId });
                
                // Responder de inmediato
                return res.json({ success: true });
            } else {
                await pool.query(`
                    UPDATE messagesapp 
                    SET hidden_by = array_append(COALESCE(hidden_by, '{}'), $1)
                    WHERE room_name = $2
                `, [myId, roomName]);
                
                return res.json({ success: true });
            }
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false });
        }
    });


    // --- 🚀 RUTA: ELIMINAR CHAT DE GRUPO ---
    router.delete('/group/:groupId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const myId = req.user.userId;
        const { groupId } = req.params;
        const { deleteForEveryone, leaveGroup } = req.query; // 'true' o 'false'

        try {
            const groupCheck = await pool.query('SELECT creator_id FROM groupsapp WHERE id = $1', [groupId]);
            if (groupCheck.rows.length === 0) return res.status(404).json({ success: false });

            const isCreator = groupCheck.rows[0].creator_id === myId;

            // 1. LÓGICA DE HISTORIAL
            if (deleteForEveryone === 'true' && isCreator) {
                // CREADOR: Borra físicamente para todos
                await pool.query('DELETE FROM messagesapp WHERE group_id = $1', [groupId]);
                 const systemContent = `🧹 El Capitán ha reiniciado el historial de mensajes.`;
                await pool.query(`
                    INSERT INTO messagesapp (sender_id, group_id, content, room_name) 
                    VALUES ($1, $2, $3, $4)
                `, [myId, groupId, systemContent, `group_${groupId}`]);

                const io = req.app.get('socketio');
                if (io) io.to(`group_${groupId}`).emit('chat_cleared', { isGroup: true });

            } else if (deleteForEveryone === 'true' || deleteForEveryone === 'false') {
                // MIEMBRO: Oculta para sí mismo
                await pool.query(`
                    UPDATE messagesapp SET hidden_by = array_append(COALESCE(hidden_by, '{}'), $1)
                    WHERE group_id = $2 AND NOT ($1 = ANY(COALESCE(hidden_by, '{}')))
                `, [myId, groupId]);
            }

            // 2. LÓGICA DE ABANDONAR GRUPO
            if (leaveGroup === 'true') {
                // Obtener nombre antes de borrarlo de la tabla miembros
                const userRes = await pool.query('SELECT username FROM usersapp WHERE id = $1', [myId]);
                const userName = userRes.rows[0].username;

                await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, myId]);
                
                // 🚀 INSERTAR AVISO DE SALIDA
                const leaveMsg = `🏃 ${userName} ha abandonado la tripulación.`;
                const msgResult = await pool.query(
                    `INSERT INTO messagesapp (sender_id, group_id, content, room_name) 
                    VALUES ($1, $2, $3, $4) RETURNING *`,
                    [myId, groupId, leaveMsg, `group_${groupId}`]
                );

                const io = req.app.get('socketio');
                if (io) io.to(`group_${groupId}`).emit('receive_message', msgResult.rows[0]);
            }

            res.json({ success: true });
        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false });
        }
    });



    // EXPULSAR MIEMBRO DEL GRUPO
    router.delete('/groups/:groupId/kick/:targetId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { groupId, targetId } = req.params;
        const myId = req.user.userId;

        try {
            // 1. Verificar si el que ejecuta tiene permiso (Admin o Creador)
            const checkPerms = await pool.query(
                'SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2',
                [groupId, myId]
            );

            if (checkPerms.rows.length === 0 || checkPerms.rows[0].role !== 'admin') {
                return res.status(403).json({ success: false, message: "No tienes rango de administrador." });
            }

            // 2. Eliminar al miembro
            const kickRes = await pool.query(
                'DELETE FROM group_members WHERE group_id = $1 AND user_id = $2 RETURNING *',
                [groupId, targetId]
            );

            if (kickRes.rowCount > 0) {
                // 3. Obtener nombres para el mensaje de sistema
                const nameRes = await pool.query('SELECT id, username FROM usersapp WHERE id = $1 OR id = $2', [myId, targetId]);

                const adminName = nameRes.rows.find(u => String(u.id) === String(myId))?.username || "Admin";
                const targetName = nameRes.rows.find(u => String(u.id) === String(targetId))?.username || "Usuario";

                // 4. Insertar mensaje de sistema en el chat 🏃
                const systemMsg = `🚫 ${targetName} ha sido expulsado por ${adminName}.`;
                const msgResult = await pool.query(
                    `INSERT INTO messagesapp (sender_id, group_id, content, room_name) 
                    VALUES ($1, $2, $3, $4) RETURNING *`,
                    [myId, groupId, systemMsg, `group_${groupId}`]
                );

                // 5. Notificar a la sala por Socket
                const io = req.app.get('socketio');
                io.to(`group_${groupId}`).emit('receive_message', msgResult.rows[0]);
                
                // Forzar recarga de permisos para todos (por si el expulsado estaba viendo el chat)
                io.to(`group_${groupId}`).emit('permissions_updated', { global: true });

                return res.json({ success: true });
            }

            res.status(404).json({ success: false, message: "El usuario no pertenece a este grupo." });

        } catch (e) {
            console.error(e);
            res.status(500).json({ success: false });
        }
    });


    // --- 🚀 RUTA: TRASPASAR MANDO Y SALIR DEL GRUPO ---
    router.post('/group/:groupId/transfer-and-leave', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const myId = req.user.userId;
        const { groupId } = req.params;
        const { newOwnerId, deleteHistory } = req.body; // 👈 Recibimos deleteHistory

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Verificar que soy el creador actual
            const check = await client.query('SELECT creator_id FROM groupsapp WHERE id = $1', [groupId]);
            if (check.rows.length === 0 || check.rows[0].creator_id !== myId) {
                throw new Error("No tienes permiso para realizar esta acción.");
            }

            // 2. 🗑️ LÓGICA DE LIMPIEZA TOTAL (Si se marcó la casilla)
            if (deleteHistory === true || deleteHistory === 'true') {
                await client.query('DELETE FROM messagesapp WHERE group_id = $1', [groupId]);
                
                // 🚀 INSERTAR MENSAJE DE SISTEMA: Esto garantiza que el chat sea visible en la lista
                const systemContent = `🧹 El historial fue eliminado por el antiguo Capitán.`;
                await client.query(`
                    INSERT INTO messagesapp (sender_id, group_id, content, room_name) 
                    VALUES ($1, $2, $3, $4)
                `, [newOwnerId, groupId, systemContent, `group_${groupId}`]);

                const io = req.app.get('socketio');
                if (io) io.to(`group_${groupId}`).emit('chat_cleared', { isGroup: true });
            }

            // 3. Cambiar el creador en la tabla de grupos
            await client.query('UPDATE groupsapp SET creator_id = $1 WHERE id = $2', [newOwnerId, groupId]);

            // 4. Asegurar que el nuevo dueño sea Administrador en la tabla de miembros
            await client.query('UPDATE group_members SET role = \'admin\' WHERE group_id = $1 AND user_id = $2', [groupId, newOwnerId]);
            
            // 5. Sacar al antiguo creador del grupo
            await client.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, myId]);

            const namesRes = await client.query('SELECT id, username FROM usersapp WHERE id IN ($1, $2)', [myId, newOwnerId]);
            const oldOwner = namesRes.rows.find(u => u.id === myId).username;
            const newOwner = namesRes.rows.find(u => u.id === newOwnerId).username;

            const transferMsg = `👑 ${oldOwner} cedió el mando a ${newOwner} y salió del grupo.`;
            const msgResult = await client.query(
                `INSERT INTO messagesapp (sender_id, group_id, content, room_name) 
                VALUES ($1, $2, $3, $4) RETURNING *`,
                [myId, groupId, transferMsg, `group_${groupId}`]
            );

            const io = req.app.get('socketio');
            if (io) io.to(`group_${groupId}`).emit('receive_message', msgResult.rows[0]);

            await client.query('COMMIT');

            // 📡 AVISO AL SOCKET PARA ACTUALIZAR ROLES E IDENTIDAD
            if (io) {
                io.to(`group_${groupId}`).emit('permissions_updated', { global: true });
            }

            res.json({ success: true });
        } catch (e) {
            await client.query('ROLLBACK');
            console.error("Error en transfer-and-leave:", e.message);
            res.status(500).json({ success: false, message: e.message });
        } finally { client.release(); }
    });

    // --- RUTAS DE ROLES DE GRUPO ---

    // 1. Obtener roles del grupo
    router.get('/groups/:groupId/roles', protect, async (req, res) => {
        try {
            const result = await pool.query('SELECT * FROM group_roles WHERE group_id = $1 ORDER BY id ASC', [req.params.groupId]);
            res.json({ success: true, roles: result.rows });
        } catch (e) { res.status(500).json({ success: false }); }
    });

    // 2. Crear o Editar Rol
    // --- 1. RUTA: CREAR ROL (POST) ---
router.post('/groups/:groupId/roles', 
    (req, res, next) => protect(req, res, next, JWT_SECRET), 
    uploadRoleIcon,         // 👈 Multer abre el paquete de datos
    processImage('group'),  // 👈 Sharp procesa el icono
    async (req, res) => {
        const { groupId } = req.params;

        try {
            if (!req.body || !req.body.name) {
                return res.status(400).json({ success: false, message: "No se recibió el nombre del rol" });
            }

            let { name, color, iconTag, permissions } = req.body;

            // Convertir permisos de String a Objeto JSON
            if (typeof permissions === 'string') {
                try { permissions = JSON.parse(permissions); } catch(e) { permissions = {}; }
            }

            // Determinar la URL del icono (Archivo > Emoji Tag > null)
            let finalIconUrl = iconTag || null;
            if (req.file) {
                finalIconUrl = `/uploads/group_photos/${req.file.filename}`;
            }

            const query = `
                INSERT INTO group_roles (group_id, name, permissions, color, icon_url, display_order) 
                VALUES ($1, $2, $3, $4, $5, 999) RETURNING *
            `;
            const result = await pool.query(query, [groupId, name, permissions, color, finalIconUrl]);

            res.json({ success: true, role: result.rows[0] });
        } catch (e) {
            console.error("❌ Error en POST roles:", e.message);
            res.status(500).json({ success: false });
        }
    }
);
    // 3. Asignar rol a un miembro
    router.post('/groups/:groupId/assign-role', protect, async (req, res) => {
        const { userId, roleId } = req.body;
        try {
            await pool.query('UPDATE group_members SET role_id = $1 WHERE group_id = $2 AND user_id = $3', 
            [roleId, req.params.groupId, userId]);
            res.json({ success: true });
        } catch (e) { res.status(500).json({ success: false }); }
    });


    // Obtener mis permisos en un grupo específico
    // SUSTITUYE LA LÍNEA DE INICIO DE LA RUTA POR ESTA:
    router.get('/groups/:groupId/my-permissions', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            const groupId = parseInt(req.params.groupId);
            const userId = req.user.userId;

            // 1. Obtener rango base, creador y roles asignados
            const query = `
                SELECT gm.role as base_rank, g.creator_id,
                    json_agg(r.permissions) as all_role_perms
                FROM group_members gm
                JOIN groupsapp g ON g.id = gm.group_id
                LEFT JOIN member_roles_link mrl ON mrl.user_id = gm.user_id AND mrl.group_id = gm.group_id
                LEFT JOIN group_roles r ON mrl.role_id = r.id
                WHERE gm.group_id = $1 AND gm.user_id = $2
                GROUP BY gm.role, g.creator_id
            `;
            const result = await pool.query(query, [groupId, userId]);
            if (result.rows.length === 0) return res.status(403).json({ success: false });

            const data = result.rows[0];
            const roles = data.all_role_perms[0] === null ? [] : data.all_role_perms;

            // --- 🚀 REGLA DE ORO: ADMINISTRADORES Y CREADORES ---
            const isGod = (String(data.creator_id) === String(userId) || 
                        data.base_rank === 'admin' || 
                        roles.some(r => r && r.is_admin === true));

            if (isGod) {
                return res.json({
                    success: true,
                    permissions: {
                        can_send_messages: true, can_send_photos: true, can_send_voice: true,
                        can_use_emojis: true, can_use_stickers: true, can_use_music: true, is_admin: true
                    }
                });
            }

            // --- 🛡️ LÓGICA DE MIEMBROS COMUNES ---
            
            // Estado inicial: Todo permitido (se usará si no hay roles ni por defecto)
            let finalPerms = {
                can_send_messages: true,
                can_send_photos: true,
                can_send_voice: true,
                can_use_emojis: true,
                can_use_stickers: true,
                can_use_music: true
            };

            if (roles.length > 0) {
                // CASO A: El usuario tiene roles específicos asignados.
                // Aplicamos el peso del "NO" (Si uno prohíbe, se bloquea).
                roles.forEach(role => {
                    if (role) {
                        if (role.can_send_messages === false) finalPerms.can_send_messages = false;
                        if (role.can_send_photos === false) finalPerms.can_send_photos = false;
                        if (role.can_send_voice === false) finalPerms.can_send_voice = false;
                        if (role.can_use_emojis === false) finalPerms.can_use_emojis = false;
                        if (role.can_use_stickers === false) finalPerms.can_use_stickers = false;
                        if (role.can_use_music === false) finalPerms.can_use_music = false;
                    }
                });
            } else {
                // 🚀 CASO B: El usuario NO tiene roles asignados.
                // Buscamos los permisos del rol "Miembro" (is_default) de este grupo.
                const defaultRoleRes = await pool.query(
                    'SELECT permissions FROM group_roles WHERE group_id = $1 AND is_default = TRUE',
                    [groupId]
                );

                if (defaultRoleRes.rows.length > 0) {
                    // Si existe el rol base, heredamos sus permisos directamente
                    finalPerms = defaultRoleRes.rows[0].permissions;
                }
            }

            res.json({ success: true, permissions: finalPerms });

        } catch (e) {
            console.error("❌ Error en my-permissions:", e.message);
            res.status(500).json({ success: false });
        }
    });

    router.post('/groups/:groupId/toggle-role', protect, async (req, res) => {
        const { userId, roleId } = req.body;
        const { groupId } = req.params;

        try {
            // 1. Verificamos si ya tiene el rol
            const check = await pool.query('SELECT 1 FROM member_roles_link WHERE user_id = $1 AND role_id = $2', [userId, roleId]);
            let actionName = "";

            if (check.rowCount > 0) {
                // Si lo tiene, lo quitamos
                await pool.query('DELETE FROM member_roles_link WHERE user_id = $1 AND role_id = $2', [userId, roleId]);
                actionName = 'removed';
            } else {
                // Si no lo tiene, lo ponemos
                await pool.query('INSERT INTO member_roles_link (group_id, user_id, role_id) VALUES ($1, $2, $3)', [groupId, userId, roleId]);
                actionName = 'added';
            }

            // ==========================================================
            // 📡 NOTIFICACIÓN POR SOCKET (TIEMPO REAL)
            // ==========================================================
            const io = req.app.get('socketio');
            if (io) {
                // Enviamos el aviso a la sala del grupo
                // El cliente del usuario recibirá esto y refrescará sus permisos
                io.to(`group_${groupId}`).emit('permissions_updated', { 
                    userId: userId,
                    action: actionName 
                });
                console.log(`📡 [SOCKET] Cambio de rol enviado a grupo_${groupId} para usuario ${userId}`);
            }
            // ==========================================================

            res.json({ success: true, action: actionName });
        } catch (e) { 
            console.error("Error en toggle-role:", e);
            res.status(500).json({ success: false }); 
        }
    });

    // 1. Editar un rol existente
    router.put('/groups/:groupId/roles/:roleId', 
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadRoleIcon, 
        processImage('group'),
        async (req, res) => {
            try {
                const { groupId, roleId } = req.params;
                let { name, permissions, color, iconTag } = req.body;
                if (typeof permissions === 'string') permissions = JSON.parse(permissions);

                let iconToUpdate = iconTag || null;
                if (req.file) {
                    iconToUpdate = `/uploads/group_photos/${req.file.filename}`;
                }

                // Construimos la query: Si no mandamos icono nuevo (es null), mantenemos el que está
                let query = `UPDATE group_roles SET name = $1, permissions = $2, color = $3`;
                let params = [name, permissions, color];

                if (iconToUpdate) {
                    query += `, icon_url = $4 WHERE id = $5 AND group_id = $6`;
                    params.push(iconToUpdate, roleId, groupId);
                } else {
                    query += ` WHERE id = $4 AND group_id = $5`;
                    params.push(roleId, groupId);
                }

                await pool.query(query, params);

                // 📡 AVISO AL SOCKET PARA ACTUALIZAR COLORES E ICONOS EN EL CHAT
                const io = req.app.get('socketio');
                if (io) {
                    io.to(`group_${groupId}`).emit('permissions_updated', { global: true });
                }

                res.json({ success: true });
            } catch (e) {
                console.error("❌ Error en PUT roles:", e.message);
                res.status(500).json({ success: false });
            }
        }
    );

    // 2. Eliminar un rol
    router.delete('/groups/:groupId/roles/:roleId', protect, async (req, res) => {
        const { groupId, roleId } = req.params;
        try {
            await pool.query(
                'DELETE FROM group_roles WHERE id = $1 AND group_id = $2',
                [roleId, groupId]
            );

            // 📡 AVISO GLOBAL AL GRUPO
            const io = req.app.get('socketio');
            if (io) {
                // Al borrar un rol, todos deben re-calcular sus permisos.
                io.to(`group_${groupId}`).emit('permissions_updated', { global: true });
                console.log(`📡 [SOCKET] Rol eliminado en grupo ${groupId}. Sincronizando...`);
            }

            res.json({ success: true });
        } catch (e) { 
            console.error("Error eliminando rol:", e);
            res.status(500).json({ success: false }); 
        }
    });


    // Obtener solo los colores de los miembros del grupo
// Obtener identidad visual (Color + Icono) de los miembros en tiempo real
router.get('/groups/:groupId/member-identity', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    try {
        const groupId = parseInt(req.params.groupId);

        if (isNaN(groupId)) {
            return res.status(400).json({ success: false, message: "ID de grupo inválido" });
        }

        const query = `
            SELECT u.id, 
                   -- 🌈 1. SUB-CONSULTA PARA EL COLOR
                   (SELECT r_sub.color 
                    FROM member_roles_link mrl_sub
                    JOIN group_roles r_sub ON mrl_sub.role_id = r_sub.id
                    WHERE mrl_sub.user_id = u.id AND mrl_sub.group_id = $1
                    ORDER BY 
                        r_sub.display_order ASC, 
                        (r_sub.permissions->>'is_admin')::boolean DESC, 
                        r_sub.id DESC
                    LIMIT 1) as name_color,

                   -- 🛡️ 2. SUB-CONSULTA PARA EL ICONO (Misma jerarquía)
                   (SELECT r_sub.icon_url 
                    FROM member_roles_link mrl_sub
                    JOIN group_roles r_sub ON mrl_sub.role_id = r_sub.id
                    WHERE mrl_sub.user_id = u.id AND mrl_sub.group_id = $1
                    ORDER BY 
                        r_sub.display_order ASC, 
                        (r_sub.permissions->>'is_admin')::boolean DESC, 
                        r_sub.id DESC
                    LIMIT 1) as role_icon

            FROM group_members gm
            JOIN usersapp u ON u.id = gm.user_id
            WHERE gm.group_id = $1
        `;

        const result = await pool.query(query, [groupId]);

        // 🚀 Convertimos a un mapa para que el Frontend lo procese al instante
        const identityMap = {};
        result.rows.forEach(row => {
            identityMap[row.id] = { 
                color: row.name_color || '#ffffff', 
                icon: row.role_icon || null 
            };
        });

        res.json({ success: true, identities: identityMap });

    } catch (e) { 
        console.error("❌ ERROR EN MEMBER-IDENTITY:", e.message);
        res.status(500).json({ success: false, error: e.message }); 
    }
});



router.post('/groups/:groupId/roles/reorder', protect, async (req, res) => {
    const { orderedIds } = req.body;
    const { groupId } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        for (let i = 0; i < orderedIds.length; i++) {
            await client.query('UPDATE group_roles SET display_order = $1 WHERE id = $2', [i, orderedIds[i]]);
        }
        await client.query('COMMIT');

        // ==========================================================
        // 📡 AVISO GLOBAL AL CHAT (NUEVO)
        // ==========================================================
        const io = req.app.get('socketio');
        if (io) {
            // Enviamos global: true porque un cambio de orden afecta las 
            // jerarquías de muchos usuarios a la vez.
            io.to(`group_${groupId}`).emit('permissions_updated', { global: true });
            console.log(`📡 [SOCKET] Jerarquía reordenada en grupo ${groupId}. Sincronizando chat...`);
        }
        // ==========================================================

        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error(e);
        res.status(500).json({ success: false });
    } finally { client.release(); }
});



// 1. Editar Nombre y Descripción
router.put('/groups/:groupId/details', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const { name, description } = req.body;
    try {
        // Validación de permisos interna
        const check = await pool.query('SELECT creator_id FROM groupsapp WHERE id = $1', [req.params.groupId]);
        if (check.rows[0].creator_id !== req.user.userId) {
            // Aquí podrías añadir el chequeo de si es admin por rol también
        }

        await pool.query(
            'UPDATE groupsapp SET name = $1, description = $2 WHERE id = $3',
            [name, description, req.params.groupId]
        );
        const io = req.app.get('socketio');
        io.to(`group_${req.params.groupId}`).emit('group_details_updated', {
            groupId: req.params.groupId,
            name: name,
            description: description
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

// 2. Editar Foto del Grupo
router.post('/groups/:groupId/update-photo', (req, res, next) => protect(req, res, next, JWT_SECRET), uploadGroupPhoto, processImage('group'), async (req, res) => {
    try {
        const photoPath = `/uploads/group_photos/${req.file.filename}`;
        await pool.query('UPDATE groupsapp SET photo_url = $1 WHERE id = $2', [photoPath, req.params.groupId]);
        const io = req.app.get('socketio');
        io.to(`group_${req.params.groupId}`).emit('group_details_updated', {
            groupId: req.params.groupId,
            photoUrl: photoPath
        });
        res.json({ success: true, photoUrl: photoPath });
    } catch (e) { res.status(500).json({ success: false }); }
});


    return router;
};