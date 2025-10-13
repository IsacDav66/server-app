// Archivo: /server/api/post.js (VERSIÓN COMPLETA Y CORREGIDA)

const express = require('express');
const { protect, softProtect } = require('../middleware/auth');
const uploadPostMiddleware = require('../middleware/uploadPost');
const processImage = require('../middleware/processImage');
const path = require('path');

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // ----------------------------------------------------
    // RUTA: Obtener el Feed de Publicaciones (/api/posts)
    // ----------------------------------------------------
    router.get('/', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const currentUserId = req.user.userId;
        try {
            const query = `
                SELECT 
                    p.post_id, p.user_id, p.content, p.image_url, p.created_at,
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
                GROUP BY p.post_id, p.user_id, u.username, u.profile_pic_url -- <-- CORREGIDO
                ORDER BY p.created_at DESC;
            `;
            const result = await pool.query(query, [currentUserId]); 
            res.status(200).json({ success: true, posts: result.rows });
        } catch (error) {
            console.error('❌ Error al obtener posts:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor al cargar el feed.' });
        }
    });


    // ==========================================================
    // === INICIO DE LA CORRECCIÓN DE ORDEN ===
    // ==========================================================

    // RUTA 2: Obtener los posts guardados (Específica) -> AHORA VA ANTES DE /:postId
    // ----------------------------------------------------
    // RUTA: Obtener los posts guardados por el usuario logueado
    // ----------------------------------------------------
    router.get('/saved', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;
        try {
            const query = `
                SELECT 
                    p.post_id, p.user_id, p.content, p.image_url, p.created_at, u.username, u.profile_pic_url,
                    COUNT(DISTINCT r.reaction_id) AS total_likes,
                    COUNT(DISTINCT c.comment_id) AS total_comments,
                    MAX(CASE WHEN r_user.user_id = $1 THEN 1 ELSE 0 END)::boolean AS is_liked_by_user,
                    TRUE AS is_saved_by_user
                FROM postapp p
                JOIN saved_postsapp s ON p.post_id = s.post_id
                JOIN usersapp u ON p.user_id = u.id
                LEFT JOIN post_reactionapp r ON p.post_id = r.post_id AND r.reaction_type = 'like'
                LEFT JOIN commentsapp c ON p.post_id = c.post_id
                LEFT JOIN post_reactionapp r_user ON p.post_id = r_user.post_id AND r_user.user_id = $1
                WHERE s.user_id = $1
                GROUP BY p.post_id, p.user_id, u.username, u.profile_pic_url
                ORDER BY MAX(s.created_at) DESC; -- <-- CORRECCIÓN: Usar una función de agregación
            `;
            const result = await pool.query(query, [loggedInUserId]);
            res.status(200).json({ success: true, posts: result.rows });
        } catch (error) {
            console.error('❌ Error al cargar los posts guardados:', error.stack);
            res.status(500).json({ success: false, message: 'Error al cargar los posts guardados.' });
        }
    });

    // ----------------------------------------------------
    // RUTA: Obtener UN solo Post (/api/posts/:postId)
    // ----------------------------------------------------
     router.get('/:postId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const postId = parseInt(req.params.postId);
        const currentUserId = req.user.userId;
        if (isNaN(postId)) return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });

        try {
            const query = `
                SELECT 
                    p.post_id, p.user_id, p.content, p.image_url, p.created_at,
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
                GROUP BY p.post_id, p.user_id, u.username, u.profile_pic_url; -- <-- CORREGIDO
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
        uploadPostMiddleware,
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
                ORDER BY c.created_at ASC;
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

        // --- VALIDACIÓN DE LÍMITE DE CARACTERES ---
        if (content.length > 500) {
            return res.status(400).json({ success: false, message: `El comentario no puede exceder los 500 caracteres.` });
        }
        // ------------------------------------------

        try {
            const query = `INSERT INTO commentsapp (post_id, user_id, content, parent_comment_id) VALUES ($1, $2, $3, $4) RETURNING comment_id;`;
            const result = await pool.query(query, [postId, userId, content, parent_comment_id || null]);
            res.status(201).json({ success: true, message: 'Comentario añadido.', commentId: result.rows[0].comment_id });
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
// RUTA: Obtener todas las publicaciones de un usuario específico
// ----------------------------------------------------
// CORRECCIÓN: Debe usar softProtect para ser una ruta pública
router.get('/user/:userId', (req, res, next) => softProtect(req, res, next, JWT_SECRET), async (req, res) => {
    const { userId } = req.params;
    const loggedInUserId = req.user ? req.user.userId : null;

    try {
        // La consulta SQL ya está correcta
        const query = `
            SELECT 
                p.post_id, p.user_id, p.content, p.image_url, p.created_at, u.username, u.profile_pic_url,
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


   

    return router;
};