const express = require('express');
const { protect } = require('../middleware/auth');
const uploadMiddleware = require('../middleware/upload');
const processImage = require('../middleware/processImage');
const uploadCoverMiddleware = require('../middleware/uploadCover');

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // Obtener un bot específico por ID
    router.get('/bots/:id', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { id } = req.params;
        try {
            const result = await pool.query('SELECT id, username, bio, bot_personality, age, gender, profile_pic_url, cover_pic_url FROM usersapp WHERE id = $1 AND is_bot = TRUE', [id]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Bot no encontrado' });
            res.json({ success: true, bot: result.rows[0] });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error al obtener el bot' });
        }
    });

    // GET /api/admin/bots
    // 1. Obtener bots (incluyendo la nueva columna)
    router.get('/bots', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            const result = await pool.query('SELECT id, username, bio, bot_personality, age, gender, profile_pic_url, cover_pic_url FROM usersapp WHERE is_bot = TRUE');
            res.json({ success: true, bots: result.rows });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error al obtener bots' });
        }
    });

    // 2. En POST /bots/update/:id, actualiza la consulta:
    router.post('/bots/update/:id', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { id } = req.params;
        const { username, bio, bot_personality, age, gender, bot_allows_images } = req.body;
        try {
            await pool.query(
                'UPDATE usersapp SET username = $1, bio = $2, bot_personality = $3, age = $4, gender = $5, bot_allows_images = $6 WHERE id = $7',
                [username, bio, bot_personality, age, gender, bot_allows_images, id]
            );
            res.json({ success: true, message: 'Bot actualizado' });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error al actualizar' });
        }
    });

    // Subir foto de perfil para un bot
    // Nota: Reutilizamos el middleware, pero necesitamos pasar el ID del bot
    router.post('/bots/upload-pic/:id', 
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadMiddleware, // Multer recibe la foto
        (req, res, next) => {
            // Guardamos el ID del BOT en el objeto de la petición
            // para que processImage lo lea y nombre el archivo correctamente.
            req.user.adminTargetId = req.params.id; 
            next();
        },
        processImage('profile'), // Sharp procesa la foto
        async (req, res) => {
            const { id } = req.params;
            const publicPath = `/uploads/profile_images/${req.file.filename}`;
            try {
                await pool.query('UPDATE usersapp SET profile_pic_url = $1 WHERE id = $2', [publicPath, id]);
                res.json({ success: true, profilePicUrl: publicPath });
            } catch (error) {
                res.status(500).json({ success: false, message: 'Error al actualizar base de datos' });
            }
        }
    );

    // NUEVA RUTA: Subir foto de portada para un bot
    router.post('/bots/upload-cover/:id', 
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadCoverMiddleware, // Middleware para archivos de portada
        (req, res, next) => {
            req.user.adminTargetId = req.params.id; // ID del bot para el nombre del archivo
            next();
        },
        processImage('cover'), // Sharp procesará esto como 'cover'
        async (req, res) => {
            const { id } = req.params;
            const publicPath = `/uploads/cover_images/${req.file.filename}`;
            try {
                await pool.query('UPDATE usersapp SET cover_pic_url = $1 WHERE id = $2', [publicPath, id]);
                res.json({ success: true, coverPicUrl: publicPath });
            } catch (error) {
                res.status(500).json({ success: false, message: 'Error al actualizar portada' });
            }
        }
    );


    // Eliminar un post de un bot (Acceso administrativo)
    router.delete('/posts/:postId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { postId } = req.params;
        try {
            // El admin puede borrar cualquier post de un usuario que sea is_bot = TRUE
            const deleteQuery = `
                DELETE FROM postapp 
                WHERE post_id = $1 AND user_id IN (SELECT id FROM usersapp WHERE is_bot = TRUE);
            `;
            const result = await pool.query(deleteQuery, [postId]);

            if (result.rowCount === 0) {
                return res.status(404).json({ success: false, message: 'Post no encontrado o no pertenece a un bot.' });
            }

            res.json({ success: true, message: 'Post del bot eliminado correctamente.' });
        } catch (error) {
            console.error(error);
            res.status(500).json({ success: false, message: 'Error al eliminar el post' });
        }
    });

    return router;
};