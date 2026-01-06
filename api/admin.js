const express = require('express');
const { protect } = require('../middleware/auth');
const uploadMiddleware = require('../middleware/upload');
const processImage = require('../middleware/processImage');

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // GET /api/admin/bots
    router.get('/bots', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            const result = await pool.query('SELECT id, username, bio, age, gender, profile_pic_url FROM usersapp WHERE is_bot = TRUE');
            res.json({ success: true, bots: result.rows });
        } catch (error) {
            console.error(error);
            res.status(500).json({ success: false, message: 'Error al obtener bots' });
        }
    });

    // Actualizar datos de un bot específico
    router.post('/bots/update/:id', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { id } = req.params;
        const { username, bio, age, gender } = req.body;
        try {
            await pool.query(
                'UPDATE usersapp SET username = $1, bio = $2, age = $3, gender = $4 WHERE id = $5 AND is_bot = TRUE',
                [username, bio, age, gender, id]
            );
            res.json({ success: true, message: 'Bot actualizado' });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error al actualizar bot' });
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

    return router;
};