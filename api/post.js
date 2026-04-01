// Archivo: /server/api/post.js (VERSIÓN COMPLETA Y CORREGIDA)

const express = require('express');
const admin = require('firebase-admin'); // 🚀 AÑADE ESTA LÍNEA
const { protect, softProtect } = require('../middleware/auth');
const uploadImageMiddleware = require('../middleware/uploadImage');
const uploadVideoMiddleware = require('../middleware/uploadVideo');
const processImage = require('../middleware/processImage');
const path = require('path');

// Al principio del archivo, junto a los otros 'require'
const { google } = require('googleapis');
const { Readable } = require('stream');

// 🚀 Función para que las notificaciones no muestren códigos o URLs largas
function cleanContentForPush(content) {
    if (!content) return "";
    if (content.includes('AUDIO')) return "🎤 Mensaje de voz";
    if (content.includes('[MEDIA_GRID:')) return "🖼️ Álbum de fotos/videos";
    if (content.includes('[MEDIA_IMAGE:')) return "📷 Foto";
    if (content.includes('[MEDIA_VIDEO:')) return "🎥 Video";
    
    // Detectar si el contenido es un Sticker o GIF (URLs crudas)
    if (content.includes('/uploads/stickers') || content.includes('giphy.com') || content.includes('/uploads/stickers_temp')) {
        return "🖼️ Sticker";
    }

    // Limpiar emojis personalizados [E:archivo.webp] -> 😊
    if (content.includes('[E:')) {
        return content.replace(/\[E:.*?\]/g, "😊").trim();
    }

    return content.length > 100 ? content.substring(0, 100) + "..." : content;
}

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // ----------------------------------------------------
    // RUTA: Obtener el Feed de Publicaciones (/api/posts) - VERSIÓN CORREGIDA
    // ----------------------------------------------------
    router.get('/', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const currentUserId = req.user.userId;

    // 🚀 1. CAPTURAR PARÁMETROS DE PAGINACIÓN
    // Si no vienen en la URL, por defecto traemos 10 posts empezando desde el 0
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;

    try {
        const query = `
            SELECT 
                p.post_id, p.user_id, p.content, p.image_url, p.created_at, p.video_id, p.shares_count,
                u.username, u.profile_pic_url,
                COUNT(DISTINCT r_all.reaction_id) AS total_likes,
                MAX(CASE WHEN r_user.user_id = $1 THEN 1 ELSE 0 END)::boolean AS is_liked_by_user,
                COUNT(DISTINCT c.comment_id) AS total_comments,
                MAX(CASE WHEN s.user_id = $1 THEN 1 ELSE 0 END)::boolean AS is_saved_by_user
            FROM postapp p
            JOIN usersapp u ON p.user_id = u.id
            LEFT JOIN post_reactionapp r_all ON p.post_id = r_all.post_id AND r_all.reaction_type = 'like'
            LEFT JOIN post_reactionapp r_user ON p.post_id = r_user.post_id AND r_user.user_id = $1 AND r_user.reaction_type = 'like'
            LEFT JOIN commentsapp c ON p.post_id = c.post_id
            LEFT JOIN saved_postsapp s ON p.post_id = s.post_id AND s.user_id = $1
            GROUP BY p.post_id, u.username, u.profile_pic_url
            ORDER BY p.created_at DESC
            LIMIT $2 OFFSET $3; -- 🚀 2. APLICAR LIMIT Y OFFSET
        `;

        // Pasamos el ID del usuario, el límite y el desplazamiento a la consulta
        const result = await pool.query(query, [currentUserId, limit, offset]); 

        res.status(200).json({ 
            success: true, 
            posts: result.rows,
            // 🚀 3. INDICADOR PARA EL FRONTEND
            // Si recibimos menos posts de los que pedimos (limit), es que ya no hay más.
            hasMore: result.rows.length === limit 
        });
    } catch (error) {
        console.error('❌ Error al obtener posts:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor al cargar el feed.' });
    }
});


    // ==========================================================
    // === INICIO DE LA CORRECCIÓN DE ORDEN ===
    // ==========================================================

    // ----------------------------------------------------
// RUTA: Obtener los posts guardados por el usuario - VERSIÓN CORREGIDA
// ----------------------------------------------------
router.get('/saved', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const loggedInUserId = req.user.userId;
    try {
        const query = `
            SELECT 
                p.post_id, p.user_id, p.content, p.image_url, p.created_at, p.video_id, -- <-- ¡LA LÍNEA QUE FALTABA!
                u.username, u.profile_pic_url,
                COUNT(DISTINCT r.reaction_id) AS total_likes,
                COUNT(DISTINCT c.comment_id) AS total_comments,
                MAX(CASE WHEN r_user.user_id = $1 THEN 1 ELSE 0 END)::boolean AS is_liked_by_user,
                TRUE AS is_saved_by_user -- Si está en esta lista, siempre está guardado
            FROM postapp p
            JOIN saved_postsapp s ON p.post_id = s.post_id
            JOIN usersapp u ON p.user_id = u.id
            LEFT JOIN post_reactionapp r ON p.post_id = r.post_id AND r.reaction_type = 'like'
            LEFT JOIN commentsapp c ON p.post_id = c.post_id
            LEFT JOIN post_reactionapp r_user ON p.post_id = r_user.post_id AND r_user.user_id = $1
            WHERE s.user_id = $1
            GROUP BY p.post_id, u.username, u.profile_pic_url -- Agrupamos por la clave primaria del post y los datos del usuario
            ORDER BY MAX(s.created_at) DESC;
        `;
        const result = await pool.query(query, [loggedInUserId]);
        res.status(200).json({ success: true, posts: result.rows });
    } catch (error) {
        console.error('❌ Error al cargar los posts guardados:', error.stack);
        res.status(500).json({ success: false, message: 'Error al cargar los posts guardados.' });
    }
});

    // ----------------------------------------------------
// RUTA: Obtener UN solo Post (/api/posts/:postId) - VERSIÓN CORREGIDA
// ----------------------------------------------------
 router.get('/:postId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const postId = parseInt(req.params.postId);
    const currentUserId = req.user.userId;
    if (isNaN(postId)) return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });

    try {
        const query = `
            SELECT 
                p.post_id, p.user_id, p.content, p.image_url, p.created_at, p.video_id, -- <-- ¡LA LÍNEA QUE FALTABA!
                u.username, u.profile_pic_url,
                COUNT(DISTINCT r_all.reaction_id) AS total_likes,
                COUNT(DISTINCT c_all.comment_id) AS total_comments,
                MAX(CASE WHEN r_user.user_id = $2 THEN 1 ELSE 0 END)::boolean AS is_liked_by_user,
                MAX(CASE WHEN s.user_id = $2 THEN 1 ELSE 0 END)::boolean AS is_saved_by_user
            FROM postapp p
            JOIN usersapp u ON p.user_id = u.id
            LEFT JOIN post_reactionapp r_all ON p.post_id = r_all.post_id AND r_all.reaction_type = 'like'
            LEFT JOIN post_reactionapp r_user ON p.post_id = r_user.post_id AND r_user.user_id = $2 AND r_user.reaction_type = 'like'
            LEFT JOIN commentsapp c_all ON p.post_id = c_all.post_id
            LEFT JOIN saved_postsapp s ON p.post_id = s.post_id AND s.user_id = $2
            WHERE p.post_id = $1
            GROUP BY p.post_id, u.username, u.profile_pic_url; -- Agrupamos por la clave primaria y datos del usuario
        `;
        const result = await pool.query(query, [postId, currentUserId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Publicación no encontrada.' });
        
        res.status(200).json({ success: true, post: result.rows[0] });
    } catch (error) {
        console.error('❌ Error al obtener post único:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor al cargar la publicación.' });
    }
});
    // ----------------------------------------------------
    // RUTA: Crear nueva publicación (/api/posts/create)
    // ----------------------------------------------------
    router.post('/create', 
        (req, res, next) => protect(req, res, next, JWT_SECRET), 
        uploadImageMiddleware,
        processImage('post'),
        async (req, res) => {
        const { content } = req.body;
        const userId = req.user.userId;
        let imageUrl = null;
        if (req.file) imageUrl = `/uploads/post_images/${req.file.filename}`; 

        if (!content && !imageUrl) return res.status(400).json({ success: false, message: 'La publicación debe tener contenido o una imagen.' });

        try {
            const query = `INSERT INTO postapp (user_id, content, image_url) VALUES ($1, $2, $3) RETURNING post_id;`;
            const result = await pool.query(query, [userId, content, imageUrl]);
            const postId = result.rows[0].post_id;
            const io = req.app.get('socketio');
            notifyFollowersOfNewPost(pool, io, admin, userId, postId, content); // 🚀 Llamada
            res.status(201).json({ success: true, message: 'Publicación creada.', postId: result.rows[0].post_id });
        } catch (error) {
            console.error('❌ Error al crear post:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // ----------------------------------------------------
    // RUTA: Alternar Reacción (Like) (/api/posts/react/:postId)
    // ----------------------------------------------------
    router.post('/react/:postId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const postId = parseInt(req.params.postId);
        const userId = req.user.userId;
        if (isNaN(postId)) return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });
        
        try {
            const deleteQuery = `DELETE FROM post_reactionapp WHERE post_id = $1 AND user_id = $2 RETURNING reaction_id;`;
            const deleteResult = await pool.query(deleteQuery, [postId, userId]);

            if (deleteResult.rowCount > 0) return res.status(200).json({ success: true, action: 'unliked' });

            const insertQuery = `INSERT INTO post_reactionapp (post_id, user_id, reaction_type) VALUES ($1, $2, 'like');`;
            await pool.query(insertQuery, [postId, userId]);
            res.status(201).json({ success: true, action: 'liked' });
        } catch (error) {
            console.error('❌ Error al procesar reacción:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });
    
    // ----------------------------------------------------
    // RUTA: Alternar Guardado de Post (/api/posts/save/:postId)
    // ----------------------------------------------------
    router.post('/save/:postId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const postId = parseInt(req.params.postId);
        const userId = req.user.userId;
        if (isNaN(postId)) return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });
        
        try {
            const deleteQuery = `DELETE FROM saved_postsapp WHERE post_id = $1 AND user_id = $2 RETURNING saved_post_id;`;
            const deleteResult = await pool.query(deleteQuery, [postId, userId]);

            if (deleteResult.rowCount > 0) return res.status(200).json({ success: true, action: 'unsaved' });

            const insertQuery = `INSERT INTO saved_postsapp (post_id, user_id) VALUES ($1, $2);`;
            await pool.query(insertQuery, [postId, userId]);
            res.status(201).json({ success: true, action: 'saved' });
        } catch (error) {
            console.error('❌ Error al procesar guardado:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // ----------------------------------------------------
    // RUTA: Obtener Comentarios de un Post (/api/posts/:postId/comments)
    // ----------------------------------------------------
    router.get('/:postId/comments', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const postId = parseInt(req.params.postId);
        if (isNaN(postId)) return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });

        try {
            const query = `
                SELECT c.comment_id, c.content, c.created_at, c.user_id, c.parent_comment_id, u.username, u.profile_pic_url
                FROM commentsapp c
                JOIN usersapp u ON c.user_id = u.id
                WHERE c.post_id = $1
                ORDER BY c.created_at DESC;
            `;
            const result = await pool.query(query, [postId]);
            res.status(200).json({ success: true, comments: result.rows });
        } catch (error) {
            console.error('❌ Error al obtener comentarios:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno al cargar comentarios.' });
        }
    });
    
    // ----------------------------------------------------
    // RUTA: Añadir un Comentario (/api/posts/:postId/comment)
    // ----------------------------------------------------
    router.post('/:postId/comment', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const postId = parseInt(req.params.postId);
        const userId = req.user.userId;
        const { content, parent_comment_id } = req.body;

        if (!content || content.trim() === '') {
            return res.status(400).json({ success: false, message: 'El contenido del comentario no puede estar vacío.' });
        }

        if (content.length > 500) {
            return res.status(400).json({ success: false, message: `El comentario no puede exceder los 500 caracteres.` });
        }

        try {
            // 1. Insertar el comentario real
            const query = `INSERT INTO commentsapp (post_id, user_id, content, parent_comment_id) VALUES ($1, $2, $3, $4) RETURNING comment_id;`;
            const result = await pool.query(query, [postId, userId, content, parent_comment_id || null]);
            
            if (result.rows.length > 0) {
                const commentId = result.rows[0].comment_id;

                try {
                    // 1. Obtener datos del emisor (el que está comentando ahora)
                    const senderRes = await pool.query('SELECT username, profile_pic_url FROM usersapp WHERE id = $1', [userId]);
                    const sender = senderRes.rows[0];

                    let recipientId = null;
                    let notifType = 'new_comment';

                    if (parent_comment_id) {
                        // 🚀 CASO A: ES UNA RESPUESTA
                        // Buscamos quién es el dueño del comentario al que estamos respondiendo
                        const parentRes = await pool.query('SELECT user_id FROM commentsapp WHERE comment_id = $1', [parent_comment_id]);
                        if (parentRes.rows.length > 0) {
                            recipientId = parentRes.rows[0].user_id;
                            notifType = 'new_reply';
                        }
                    } 
                    
                    if (!recipientId) {
                        // 🚀 CASO B: ES COMENTARIO RAÍZ
                        // Buscamos al dueño del post
                        const postRes = await pool.query('SELECT user_id FROM postapp WHERE post_id = $1', [postId]);
                        if (postRes.rows.length > 0) {
                            recipientId = postRes.rows[0].user_id;
                            notifType = 'new_comment';
                        }
                    }

                    // 2. Solo notificamos si el receptor NO es el mismo que el emisor
                    if (recipientId && recipientId !== userId) {
                        
                        // 3. Insertar en la tabla de notificaciones
                        const notifQuery = `
                            INSERT INTO notificationsapp (recipient_id, sender_id, type, content, post_id, comment_id)
                            VALUES ($1, $2, $3, $4, $5, $6)
                            RETURNING *;
                        `;
                        const notifResult = await pool.query(notifQuery, [recipientId, userId, notifType, content, postId, commentId]);

                        // 4. Avisar por SOCKET (Tiempo Real)
                        const io = req.app.get('socketio');
                        const notificationPayload = {
                            ...notifResult.rows[0],
                            sender_username: sender.username,
                            sender_profile_pic_url: sender.profile_pic_url
                        };
                        io.to(`user-${recipientId}`).emit('new_notification', notificationPayload);

                        // 5. Enviar PUSH (Firebase) - VERSION FINAL CORREGIDA
                        const tokenRes = await pool.query('SELECT fcm_token FROM usersapp WHERE id = $1', [recipientId]);
                        if (tokenRes.rows[0]?.fcm_token) {
                            
                            // 🚀 USAMOS LA NUEVA FUNCIÓN DE LIMPIEZA
                            const bodySnippet = cleanContentForPush(content);

                            const pushTitle = notifType === 'new_reply' ? 'Nueva respuesta' : 'AnarkWorld';
                            const pushBody = notifType === 'new_reply' 
                                ? `${sender.username} respondió a tu comentario: ${bodySnippet}`
                                : `${sender.username} comentó tu post: ${bodySnippet}`;

                            const message = {
                                token: tokenRes.rows[0].fcm_token,
                                data: {
                                    title: pushTitle, // "Nueva respuesta" o "AnarkWorld"
                                    body: pushBody,   // "Isac comentó tu post..."
                                    channelId: 'social_channel',
                                    groupId: 'comments', // Agrupa todos los comentarios juntos
                                    senderId: String(userId),
                                    openUrl: `comments.html?postId=${postId}&targetComment=${commentId}&groupId=comments`,
                                    imageUrl: sender.profile_pic_url ? (process.env.PUBLIC_SERVER_URL + sender.profile_pic_url).trim() : ""
                                },
                                android: { priority: 'high' }
                            };

                            // Envío asíncrono para no retrasar la respuesta al usuario
                            admin.messaging().send(message).catch(e => console.error("❌ Error enviando Push Comentario:", e));
                        }
                    }
                } catch (notifErr) {
                    console.error("⚠️ Error procesando notificación:", notifErr);
                }

                res.status(201).json({ success: true, message: 'Comentario añadido.', commentId });
            }
        } catch (error) {
            console.error('❌ Error al añadir comentario:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno al añadir comentario.' });
        }
    });

    // ----------------------------------------------------
    // RUTA: Eliminar un Comentario (/api/posts/comment/:commentId)
    // ----------------------------------------------------
    router.delete('/comment/:commentId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const commentId = parseInt(req.params.commentId);
        const userId = req.user.userId;
        if (isNaN(commentId)) return res.status(400).json({ success: false, message: 'ID de comentario inválido.' });

        try {
            const deleteQuery = `DELETE FROM commentsapp WHERE comment_id = $1 AND user_id = $2 RETURNING comment_id;`;
            const deleteResult = await pool.query(deleteQuery, [commentId, userId]);
            if (deleteResult.rowCount === 0) return res.status(403).json({ success: false, message: 'No tienes permiso o el comentario no existe.' });
            
            res.status(200).json({ success: true, message: 'Comentario eliminado.' });
        } catch (error) {
            console.error('❌ Error al eliminar comentario:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno al eliminar el comentario.' });
        }
    });

// ----------------------------------------------------
// RUTA: Obtener todas las publicaciones de un usuario específico - VERSIÓN CORREGIDA
// ----------------------------------------------------
router.get('/user/:userId', (req, res, next) => softProtect(req, res, next, JWT_SECRET), async (req, res) => {
    const { userId } = req.params;
    const loggedInUserId = req.user ? req.user.userId : null;

    try {
        const query = `
            SELECT 
                p.post_id, p.user_id, p.content, p.image_url, p.created_at, p.video_id, -- <-- ¡LA LÍNEA QUE FALTABA!
                u.username, u.profile_pic_url,
                COUNT(DISTINCT r.reaction_id) AS total_likes,
                COUNT(DISTINCT c.comment_id) AS total_comments,
                MAX(CASE WHEN r_user.user_id = $2 THEN 1 ELSE 0 END)::boolean AS is_liked_by_user,
                MAX(CASE WHEN s.user_id = $2 THEN 1 ELSE 0 END)::boolean AS is_saved_by_user
            FROM postapp p
            JOIN usersapp u ON p.user_id = u.id
            LEFT JOIN post_reactionapp r ON p.post_id = r.post_id AND r.reaction_type = 'like'
            LEFT JOIN commentsapp c ON p.post_id = c.post_id
            LEFT JOIN post_reactionapp r_user ON p.post_id = r_user.post_id AND r_user.user_id = $2
            LEFT JOIN saved_postsapp s ON p.post_id = s.post_id AND s.user_id = $2
            WHERE p.user_id = $1
            GROUP BY p.post_id, u.username, u.profile_pic_url
            ORDER BY p.created_at DESC;
        `;
        const result = await pool.query(query, [userId, loggedInUserId]);
        res.status(200).json({ success: true, posts: result.rows });
    } catch (error) {
        console.error(error.stack);
        res.status(500).json({ success: false, message: 'Error al cargar las publicaciones del usuario.' });
    }
});


   

// ====================================================
    // === NUEVA RUTA: CREAR POST CON VIDEO (YOUTUBE)   ===
    // ====================================================
    router.post('/create-video-post', 
        (req, res, next) => protect(req, res, next, JWT_SECRET), 
        uploadVideoMiddleware, // Reutilizamos el middleware para recibir el archivo
        async (req, res) => {
            const { content } = req.body;
            const userId = req.user.userId;

            if (!req.file) {
                return res.status(400).json({ success: false, message: 'No se ha subido ningún archivo de video.' });
            }

            try {
                // 1. Autenticar con Google usando el refresh token
                const oauth2Client = new google.auth.OAuth2(
                    process.env.YOUTUBE_CLIENT_ID,
                    process.env.YOUTUBE_CLIENT_SECRET,
                    process.env.YOUTUBE_REDIRECT_URI
                );
                oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
                
                const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

                // 2. Subir el video a YouTube
                const response = await youtube.videos.insert({
                    part: 'snippet,status',
                    requestBody: {
                        snippet: {
                            title: `Video de Omlet Arcade - Usuario #${userId}`,
                            description: content || 'Video subido desde Omlet Web Arcade.',
                        },
                        status: {
                            privacyStatus: 'unlisted', // 'unlisted' es ideal para que no aparezca en tu canal público
                        },
                    },
                    media: {
                        body: Readable.from(req.file.buffer), // Convertimos el buffer del video a un stream
                    },
                });

                const videoId = response.data.id;
                if (!videoId) {
                    throw new Error('La API de YouTube no devolvió un ID de video.');
                }

                // 3. Guardar el post en nuestra base de datos con el videoId
                const query = `
                    INSERT INTO postapp (user_id, content, video_id) 
                    VALUES ($1, $2, $3) RETURNING post_id;
                `;
                const result = await pool.query(query, [userId, content, videoId]);
                const postId = result.rows[0].post_id;
                const io = req.app.get('socketio');
                notifyFollowersOfNewPost(pool, io, admin, userId, postId, content); // 🚀 Llamada
                res.status(201).json({ 
                    success: true, 
                    message: 'Video publicado con éxito.', 
                    postId: result.rows[0].post_id 
                });

            } catch (error) {
                console.error('❌ Error al subir video a YouTube o guardar el post:', error);
                res.status(500).json({ success: false, message: 'Error interno del servidor al procesar el video.' });
            }
        }
    );

    // ====================================================
// === NUEVA RUTA: ELIMINAR UNA PUBLICACIÓN         ===
// ====================================================
router.delete('/:postId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const postId = parseInt(req.params.postId);
    const userId = req.user.userId; // ID del usuario que hace la solicitud

    if (isNaN(postId)) {
        return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });
    }

    try {
        // ¡LA CLÁUSULA DE SEGURIDAD MÁS IMPORTANTE!
        // La consulta DELETE solo tendrá éxito si el post_id coincide Y el user_id
        // del post coincide con el ID del usuario que está haciendo la solicitud.
        const deleteQuery = `
            DELETE FROM postapp 
            WHERE post_id = $1 AND user_id = $2;
        `;
        
        const result = await pool.query(deleteQuery, [postId, userId]);

        // Si result.rowCount es 0, significa que no se eliminó ninguna fila.
        // Esto ocurre si el post no existe O si el usuario no es el propietario.
        if (result.rowCount === 0) {
            return res.status(403).json({ success: false, message: 'No tienes permiso para eliminar esta publicación o no existe.' });
        }

        // Si se eliminó una fila, la operación fue exitosa.
        res.status(200).json({ success: true, message: 'Publicación eliminada correctamente.' });

    } catch (error) {
        console.error('❌ Error al eliminar la publicación:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor al eliminar la publicación.' });
    }
});

// 🚀 Debemos pasar (req, res, next) y el JWT_SECRET al middleware protect
router.post('/share-increment/:postId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const { postId } = req.params;
    
    // Ahora req.user ya no será undefined porque el middleware se ejecutó bien
    const userId = req.user.userId;

    try {
        // 1. Intentamos registrar el compartido en la tabla de logs
        await pool.query(
            'INSERT INTO post_shares (user_id, post_id) VALUES ($1, $2)',
            [userId, postId]
        );

        // 2. Incrementamos el contador global
        const result = await pool.query(
            'UPDATE postapp SET shares_count = shares_count + 1 WHERE post_id = $1 RETURNING shares_count',
            [postId]
        );

        res.json({ 
            success: true, 
            incremented: true, 
            newCount: result.rows[0].shares_count 
        });

    } catch (e) {
        if (e.code === '23505') {
            return res.json({ 
                success: true, 
                incremented: false, 
                message: 'Ya compartido.' 
            });
        }
        console.error("Error share logic:", e);
        res.status(500).json({ success: false });
    }
});



// 🚀 FUNCIÓN AUXILIAR PARA NOTIFICAR A SEGUIDORES Y AMIGOS
// 🚀 FUNCIÓN AUXILIAR ACTUALIZADA
async function notifyFollowersOfNewPost(pool, io, admin, authorId, postId, content, videoId = null) {
    try {
        // 1. Buscamos a los seguidores. 
        // Simplificamos el SQL: Solo necesitamos saber si el autor (following_id) 
        // también sigue al seguidor (follower_id).
        const followersRes = await pool.query(`
            SELECT 
                f.follower_id as recipient_id,
                u.username as author_name,
                u.profile_pic_url as author_avatar,
                EXISTS (
                    SELECT 1 FROM followersapp 
                    WHERE follower_id = f.following_id 
                    AND following_id = f.follower_id
                ) as is_friend
            FROM followersapp f
            JOIN usersapp u ON u.id = f.following_id
            WHERE f.following_id = $1
        `, [authorId]);

        const followers = followersRes.rows;

        for (let row of followers) {
            const { recipient_id, author_name, author_avatar, is_friend } = row;

            // 2. Insertar en la campana
            const notifQuery = `
                INSERT INTO notificationsapp (recipient_id, sender_id, type, content, post_id)
                VALUES ($1, $2, 'new_post', $3, $4)
                RETURNING *;
            `;
            // Guardamos un texto sutil para el content de la DB
            const dbContent = videoId ? "[VIDEO]" : (content ? content.substring(0, 50) : "[IMAGEN]");
            const notifResult = await pool.query(notifQuery, [recipient_id, authorId, dbContent, postId]);

            // 3. Socket (Tiempo Real)
            const notificationPayload = {
                ...notifResult.rows[0],
                sender_username: author_name,
                sender_profile_pic_url: author_avatar,
                is_friend: is_friend
            };
            io.to(`user-${recipient_id}`).emit('new_notification', notificationPayload);

            // 4. Enviar PUSH (Firebase)
            const tokenRes = await pool.query('SELECT fcm_token FROM usersapp WHERE id = $1', [recipient_id]);
            const token = tokenRes.rows[0]?.fcm_token;

            if (token) {
                const bodyText = is_friend 
                    ? `¡Tu amigo ${author_name} hizo una nueva publicación!` 
                    : `${author_name} publicó algo nuevo.`;

                const targetPage = videoId ? 'video_feed.html' : 'comments.html';

                const message = {
                    token: token,
                    data: {
                        title: 'AnarkWorld',
                        body: bodyText, // "Isac publicó algo nuevo"
                        channelId: 'social_channel',
                        groupId: 'new_posts',
                        senderId: String(authorId),
                        openUrl: videoId ? `video_feed.html?postId=${postId}` : `comments.html?postId=${postId}`,
                        imageUrl: author_avatar ? (process.env.PUBLIC_SERVER_URL + author_avatar).trim() : ""
                    },
                    android: { priority: 'high' }
                };

                admin.messaging().send(message).catch(e => console.error("Push Error (New Post):", e));
            }
        }
    } catch (err) {
        console.error("Error al notificar seguidores:", err);
    }
}

return router;
};