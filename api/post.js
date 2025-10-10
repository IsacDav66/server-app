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
        try {
            const query = `
                SELECT 
                    p.post_id, 
                    p.content, 
                    p.image_url, 
                    p.created_at,
                    u.username,
                    u.profile_pic_url
                FROM postapp p
                JOIN usersapp u ON p.user_id = u.id
                ORDER BY p.created_at DESC;
            `;
            const result = await pool.query(query);

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
    // RUTA FUTURA: Reaccionar a una publicación
    // ----------------------------------------------------
    // router.post('/react/:postId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    //     // Lógica para INSERT INTO post_reactionapp ...
    // });
    
    return router;
};