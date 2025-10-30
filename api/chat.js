// Archivo: server/api/chat.js
const express = require('express');
const { protect } = require('../middleware/auth');

// Aceptamos 'io' como un nuevo parámetro
module.exports = (pool, JWT_SECRET, io) => {
    const router = express.Router();
     // ==========================================================
    // === ¡NUEVA RUTA PARA OBTENER LA LISTA DE CONVERSACIONES! ===
    // ==========================================================
    router.get('/conversations', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;

        try {
            // Esta consulta SQL avanzada utiliza una "Window Function" para encontrar
            // el último mensaje de cada conversación de forma eficiente.
            const query = `
                WITH RankedMessages AS (
                    SELECT
                        m.message_id,
                        m.sender_id,
                        m.receiver_id,
                        m.content,
                        m.created_at,
                        -- Identificamos al "otro" usuario en la conversación
                        CASE
                            WHEN m.sender_id = $1 THEN m.receiver_id
                            ELSE m.sender_id
                        END AS other_user_id,
                        -- Asignamos un número de fila a cada mensaje dentro de su conversación,
                        -- ordenado por fecha descendente (el más nuevo es el 1).
                        ROW_NUMBER() OVER(
                            PARTITION BY 
                                CASE WHEN m.sender_id = $1 THEN m.receiver_id ELSE m.sender_id END 
                            ORDER BY m.created_at DESC
                        ) as rn
                    FROM messagesapp m
                    WHERE m.sender_id = $1 OR m.receiver_id = $1
                )
                -- Seleccionamos solo los mensajes más recientes (rn = 1) de cada conversación
                SELECT
                    rm.content AS last_message_content,
                    rm.created_at AS last_message_at,
                    rm.sender_id AS last_message_sender_id,
                    u.id AS user_id,
                    u.username,
                    u.profile_pic_url
                FROM RankedMessages rm
                JOIN usersapp u ON rm.other_user_id = u.id
                WHERE rm.rn = 1
                ORDER BY rm.created_at DESC; -- Ordenamos las conversaciones por la más reciente
            `;

            const result = await pool.query(query, [loggedInUserId]);
            res.status(200).json({ success: true, conversations: result.rows });

        } catch (error) {
            console.error('Error al obtener la lista de conversaciones:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });
    

    // Ruta para obtener el historial de mensajes entre dos usuarios
    router.get('/history/:otherUserId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        const otherUserId = parseInt(req.params.otherUserId);

        if (isNaN(otherUserId)) {
            return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });
        }

        try {
            // --- CONSULTA ACTUALIZADA CON LEFT JOIN ---
            const query = `
                SELECT 
                    m.message_id, m.sender_id, m.receiver_id, m.content, m.created_at, m.parent_message_id,
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
            console.error("Error al obtener el historial del chat:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });



    // ====================================================
    // === NUEVA RUTA: ELIMINAR UN MENSAJE              ===
    // ====================================================
    // REEMPLAZA tu ruta DELETE con esta
    router.delete('/messages/:messageId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        const messageId = parseInt(req.params.messageId);

        if (isNaN(messageId)) {
            return res.status(400).json({ success: false, message: 'ID de mensaje inválido.' });
        }

        try {
            // 1. PRIMERO, verificamos la propiedad y obtenemos los IDs para la sala de socket
            const ownershipQuery = 'SELECT sender_id, receiver_id FROM messagesapp WHERE message_id = $1';
            const ownershipResult = await pool.query(ownershipQuery, [messageId]);

            if (ownershipResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Mensaje no encontrado.' });
            }

            const message = ownershipResult.rows[0];
            if (message.sender_id !== loggedInUserId) {
                return res.status(403).json({ success: false, message: 'No tienes permiso para eliminar este mensaje.' });
            }

            // 2. AHORA, eliminamos el mensaje
            const deleteQuery = 'DELETE FROM messagesapp WHERE message_id = $1';
            await pool.query(deleteQuery, [messageId]);

            // 3. ¡LA CLAVE! Emitimos un evento a la sala de chat
            const roomName = [message.sender_id, message.receiver_id].sort().join('-');
            io.to(roomName).emit('message_deleted', { messageId: messageId });
            
            // 4. Respondemos a la petición original
            res.status(200).json({ success: true, message: 'Mensaje eliminado.' });
        } catch (error) {
            console.error("Error al eliminar el mensaje:", error);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    return router;
};