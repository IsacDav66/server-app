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
        const currentUserId = req.user.userId; // <-- CLAVE: Obtener el ID del usuario actual

        try {
            const query = `
                SELECT 
                    p.post_id, 
                    p.content, 
                    p.image_url, 
                    p.created_at,
                    u.username,
                    u.profile_pic_url,
                    -- CLAVE: Contar el número total de likes
                    COALESCE(COUNT(r_all.reaction_id), 0) AS total_likes,
                    -- CLAVE: Chequear si el usuario actual ya dio like (existe una fila)
                    MAX(CASE WHEN r_user.user_id = $1 THEN TRUE ELSE FALSE END) AS is_liked_by_user
                FROM postapp p
                JOIN usersapp u ON p.user_id = u.id
                LEFT JOIN post_reactionapp r_all ON p.post_id = r_all.post_id AND r_all.reaction_type = 'like'
                LEFT JOIN post_reactionapp r_user ON p.post_id = r_user.post_id AND r_user.user_id = $1 AND r_user.reaction_type = 'like'
                GROUP BY p.post_id, u.username, u.profile_pic_url
                ORDER BY p.created_at DESC;
            `;
            const result = await pool.query(query, [currentUserId]); // <-- Usar el ID aquí

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
    
    return router;
};