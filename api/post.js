// Archivo: /server/api/post.js

const express = require('express');
const { protect } = require('../middleware/auth'); 
const uploadPostMiddleware = require('../middleware/uploadPost'); // <-- Importar el middleware de subida
const path = require('path'); 

// Módulo para manejar las publicaciones
module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // ----------------------------------------------------
    // RUTA: Obtener el Feed de Publicaciones (/api/posts)
    // ----------------------------------------------------
    // Por simplicidad, obtiene todos los posts con el nombre de usuario del autor.
    router.get('/', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const currentUserId = req.user.userId;

        try {
            const query = `
    SELECT 
        p.post_id, 
        p.content, 
        p.image_url, 
        p.created_at,
        u.username,
        u.profile_pic_url,
        COUNT(DISTINCT r_all.reaction_id) AS total_likes,
        MAX(CASE WHEN r_user.user_id = $1 THEN 1 ELSE 0 END)::boolean AS is_liked_by_user,
        COUNT(DISTINCT c.comment_id) AS total_comments,
        -- LÍNEA CLAVE AÑADIDA: Chequear si el post está guardado por el usuario actual
        MAX(CASE WHEN s.user_id = $1 THEN 1 ELSE 0 END)::boolean AS is_saved_by_user
    FROM postapp p
    JOIN usersapp u ON p.user_id = u.id
    LEFT JOIN post_reactionapp r_all ON p.post_id = r_all.post_id AND r_all.reaction_type = 'like'
    LEFT JOIN post_reactionapp r_user ON p.post_id = r_user.post_id AND r_user.user_id = $1 AND r_user.reaction_type = 'like'
    LEFT JOIN commentsapp c ON p.post_id = c.post_id
    -- JOIN AÑADIDO: Unir con la tabla de posts guardados
    LEFT JOIN saved_postsapp s ON p.post_id = s.post_id AND s.user_id = $1
    GROUP BY p.post_id, u.username, u.profile_pic_url
    ORDER BY p.created_at DESC;
`;
            const result = await pool.query(query, [currentUserId]); 

            res.status(200).json({
                success: true,
                message: 'Feed cargado con éxito.',
                posts: result.rows
            });

        } catch (error) {
            console.error('❌ Error al obtener posts:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor al cargar el feed.' });
        }
    });


    // ----------------------------------------------------
    // NUEVA RUTA: Obtener UN solo Post (/api/posts/:postId)
    // ----------------------------------------------------
     router.get('/:postId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const postId = parseInt(req.params.postId);
        const currentUserId = req.user.userId; // CLAVE: Obtener el ID del usuario actual

        if (isNaN(postId)) {
            return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });
        }

        try {
            const query = `
    SELECT 
        p.post_id, 
        p.content, 
        p.image_url, 
        p.created_at,
        u.username,
        u.profile_pic_url,
        -- CORRECCIÓN: Contar solo los IDs de reacción ÚNICOS
        COUNT(DISTINCT r_all.reaction_id) AS total_likes,
        -- CORRECCIÓN: Contar solo los IDs de comentario ÚNICOS
        COUNT(DISTINCT c_all.comment_id) AS total_comments,
        MAX(CASE WHEN r_user.user_id = $2 THEN 1 ELSE 0 END)::boolean AS is_liked_by_user
    FROM postapp p
    JOIN usersapp u ON p.user_id = u.id
    LEFT JOIN post_reactionapp r_all ON p.post_id = r_all.post_id AND r_all.reaction_type = 'like'
    LEFT JOIN post_reactionapp r_user ON p.post_id = r_user.post_id AND r_user.user_id = $2 AND r_user.reaction_type = 'like'
    LEFT JOIN commentsapp c_all ON p.post_id = c_all.post_id
    WHERE p.post_id = $1
    GROUP BY p.post_id, u.username, u.profile_pic_url;
`;
            const result = await pool.query(query, [postId, currentUserId]); // CLAVE: Pasar el currentUserId como $2

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Publicación no encontrada.' });
            }

            res.status(200).json({
                success: true,
                post: result.rows[0] // Devolvemos el post con los contadores
            });

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
        uploadPostMiddleware, // 2. Multer sube la imagen (opcional)
        async (req, res) => {
        
        const { content } = req.body;
        const userId = req.user.userId;
        let imageUrl = null;
        
        // 1. Determinar la URL de la imagen si se subió un archivo
        if (req.file) {
            // '/uploads/post_images' es la ruta pública que Express sirve estáticamente
            imageUrl = `/uploads/post_images/${req.file.filename}`; 
        }

        // Validación: Debe haber contenido o una imagen
        if (!content && !imageUrl) {
            return res.status(400).json({ success: false, message: 'La publicación debe tener contenido o una imagen.' });
        }

        try {
            // 2. Insertar la publicación en la BD
            const query = `
                INSERT INTO postapp (user_id, content, image_url) 
                VALUES ($1, $2, $3) 
                RETURNING post_id, created_at;
            `;
            const result = await pool.query(query, [userId, content, imageUrl]);

            res.status(201).json({ 
                success: true, 
                message: 'Publicación creada con éxito.',
                postId: result.rows[0].post_id,
                created_at: result.rows[0].created_at,
                imageUrl: imageUrl 
            });

        } catch (error) {
            console.error('❌ Error al crear post:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor al crear la publicación.' });
        }
    });




    // ----------------------------------------------------
// RUTA: Alternar Reacción (Like) (/api/posts/react/:postId)
// ----------------------------------------------------
router.post('/react/:postId', 
    (req, res, next) => protect(req, res, next, JWT_SECRET), 
    async (req, res) => {
    
    const postId = parseInt(req.params.postId);
    const userId = req.user.userId;
    const reactionType = 'like'; // Usamos 'like' como tipo fijo por ahora

    if (isNaN(postId)) {
        return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });
    }

    try {
        // 1. INTENTAR ELIMINAR la reacción existente
        const deleteQuery = `
            DELETE FROM post_reactionapp 
            WHERE post_id = $1 AND user_id = $2 AND reaction_type = $3
            RETURNING reaction_id;
        `;
        const deleteResult = await pool.query(deleteQuery, [postId, userId, reactionType]);

        if (deleteResult.rowCount > 0) {
            // Si se eliminó una fila, el usuario estaba dando "like" y lo ha quitado
            return res.status(200).json({ 
                success: true, 
                action: 'unliked', 
                message: 'Me gusta eliminado con éxito.' 
            });
        }

        // 2. Si no se eliminó nada, AÑADIR la nueva reacción
        const insertQuery = `
            INSERT INTO post_reactionapp (post_id, user_id, reaction_type) 
            VALUES ($1, $2, $3)
            RETURNING reaction_id;
        `;
        const insertResult = await pool.query(insertQuery, [postId, userId, reactionType]);
        
        // Si se insertó correctamente
        if (insertResult.rowCount > 0) {
            return res.status(201).json({ 
                success: true, 
                action: 'liked', 
                message: 'Me gusta añadido con éxito.' 
            });
        }
        
    } catch (error) {
        // En caso de un error inesperado (ej. post_id inválido o BD inaccesible)
        console.error('❌ Error al procesar reacción:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor al procesar el "Me Gusta".' });
    }
});
    



// ----------------------------------------------------
// RUTA: Obtener Comentarios de un Post (/api/posts/:postId/comments) - CORREGIDA
// ----------------------------------------------------
router.get('/:postId/comments', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const postId = parseInt(req.params.postId);

    if (isNaN(postId)) {
        return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });
    }

    try {
        const query = `
            SELECT 
                c.comment_id, 
                c.content, 
                c.created_at,
                c.user_id,
                c.parent_comment_id, -- <--- ¡¡¡LÍNEA AÑADIDA!!!
                u.username, 
                u.profile_pic_url
            FROM commentsapp c
            JOIN usersapp u ON c.user_id = u.id
            WHERE c.post_id = $1
            ORDER BY c.created_at ASC;
        `;
        const result = await pool.query(query, [postId]);

        res.status(200).json({
            success: true,
            comments: result.rows
        });

    } catch (error) {
        console.error('❌ Error al obtener comentarios:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno al cargar comentarios.' });
    }
});
    
    // ----------------------------------------------------
    // NUEVA RUTA: Añadir un Comentario (/api/posts/:postId/comment)
    // ----------------------------------------------------
    router.post('/:postId/comment', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const postId = parseInt(req.params.postId);
        const userId = req.user.userId;
        const { content, parent_comment_id } = req.body; // parent_comment_id para futuros subcomentarios

        if (!content) {
            return res.status(400).json({ success: false, message: 'El contenido del comentario no puede estar vacío.' });
        }

        try {
            const query = `
            INSERT INTO commentsapp (post_id, user_id, content, parent_comment_id)
            VALUES ($1, $2, $3, $4)
            RETURNING comment_id, created_at;
        `;
        const result = await pool.query(query, [postId, userId, content, parent_comment_id || null]); // <-- INSERTA correctamente

            res.status(201).json({
                success: true,
                message: 'Comentario añadido con éxito.',
                commentId: result.rows[0].comment_id
            });

        } catch (error) {
            console.error('❌ Error al añadir comentario:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno al añadir comentario.' });
        }
    });



      // ----------------------------------------------------
    // NUEVA RUTA: Eliminar un Comentario (/api/posts/comment/:commentId)
    // ----------------------------------------------------
    router.delete('/comment/:commentId', 
        (req, res, next) => protect(req, res, next, JWT_SECRET), 
        async (req, res) => {
        
        const commentId = parseInt(req.params.commentId);
        const userId = req.user.userId; // ID del usuario que intenta borrar

        if (isNaN(commentId)) {
            return res.status(400).json({ success: false, message: 'ID de comentario inválido.' });
        }

        try {
            // CLAVE: La consulta solo elimina si el user_id del comentario es igual al user_id del token.
            const deleteQuery = `
                DELETE FROM commentsapp 
                WHERE comment_id = $1 AND user_id = $2
                RETURNING comment_id;
            `;
            const deleteResult = await pool.query(deleteQuery, [commentId, userId]);

            if (deleteResult.rowCount === 0) {
                // Falla si el comentario no existe O si no pertenece al usuario
                return res.status(403).json({ success: false, message: 'No tienes permiso para eliminar este comentario o no existe.' });
            }

            res.status(200).json({ 
                success: true, 
                message: 'Comentario eliminado con éxito.' 
            });

        } catch (error) {
            console.error('❌ Error al eliminar comentario:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno al eliminar el comentario.' });
        }
    });





    // ----------------------------------------------------
// NUEVA RUTA: Alternar Guardado de Post (/api/posts/save/:postId)
// ----------------------------------------------------
router.post('/save/:postId', 
    (req, res, next) => protect(req, res, next, JWT_SECRET), 
    async (req, res) => {
    
    const postId = parseInt(req.params.postId);
    const userId = req.user.userId;

    if (isNaN(postId)) {
        return res.status(400).json({ success: false, message: 'ID de publicación inválido.' });
    }

    try {
        // 1. Intentar eliminar el registro de la tabla de guardados
        const deleteQuery = `
            DELETE FROM saved_postsapp 
            WHERE post_id = $1 AND user_id = $2
            RETURNING saved_post_id;
        `;
        const deleteResult = await pool.query(deleteQuery, [postId, userId]);

        if (deleteResult.rowCount > 0) {
            // Si se eliminó una fila, el usuario está "desguardando" el post
            return res.status(200).json({ 
                success: true, 
                action: 'unsaved', 
                message: 'Publicación eliminada de guardados.' 
            });
        }

        // 2. Si no se eliminó nada, significa que no estaba guardado, así que lo insertamos
        const insertQuery = `
            INSERT INTO saved_postsapp (post_id, user_id) 
            VALUES ($1, $2)
            RETURNING saved_post_id;
        `;
        await pool.query(insertQuery, [postId, userId]);
        
        return res.status(201).json({ 
            success: true, 
            action: 'saved', 
            message: 'Publicación guardada con éxito.' 
        });
        
    } catch (error) {
        console.error('❌ Error al procesar guardado de post:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor al procesar la solicitud.' });
    }
});




    return router;
};