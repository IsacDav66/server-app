// Archivo: /server/api/user.js (VERSIÓN COMPLETA Y CORREGIDA)

const express = require('express');
const { protect } = require('../middleware/auth');
const uploadMiddleware = require('../middleware/upload');
const uploadCoverMiddleware = require('../middleware/uploadCover'); // <-- 1. IMPORTAR NUEVO MIDDLEWARE
const processImage = require('../middleware/processImage');
const path = require('path');

module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();

    // RUTA PROTEGIDA: Obtener datos del usuario LOGUEADO
    router.get('/me', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        try {
            // Se añade 'cover_pic_url'
            const query = 'SELECT id, email, username, age, gender, profile_pic_url, bio, cover_pic_url FROM usersapp WHERE id = $1';
            const result = await pool.query(query, [req.user.userId]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado.' });
            
            const user = result.rows[0];
            const isProfileComplete = !!user.username;
            
            res.status(200).json({ success: true, data: { userId: user.id, ...user, isProfileComplete } });
        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error al obtener los datos del usuario.' });
        }
    });

    // RUTA PÚBLICA: Obtener datos de perfil de CUALQUIER usuario
    router.get('/profile/:userId', async (req, res) => {
        const userId = parseInt(req.params.userId, 10);
        if (isNaN(userId)) return res.status(400).json({ success: false, message: 'El ID de usuario no es válido.' });

        try {
            const query = `
                SELECT 
                    u.id, u.username, u.profile_pic_url, u.bio, u.cover_pic_url, -- <-- 2. AÑADIR cover_pic_url
                    (SELECT COUNT(*) FROM postapp WHERE user_id = u.id) AS post_count,
                    (SELECT COUNT(*) FROM followersapp WHERE following_id = u.id) AS followers_count,
                    (SELECT COUNT(*) FROM followersapp WHERE follower_id = u.id) AS following_count
                FROM usersapp u
                WHERE u.id = $1;
            `;
            const result = await pool.query(query, [userId]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Perfil no encontrado.' });
            
            res.status(200).json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno al obtener el perfil.' });
        }
    });

    // ----------------------------------------------------
    // RUTA: Actualizar/Completar Perfil (MEJORADA)
    // ----------------------------------------------------
    router.post('/complete-profile', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { username, age, gender, bio } = req.body;
        const userId = req.user.userId;

        if (!username) {
            return res.status(400).json({ success: false, message: 'El nombre de usuario es obligatorio.' });
        }

        try {
            const query = `
                UPDATE usersapp SET 
                    username = COALESCE($1, username), 
                    age = COALESCE($2, age), 
                    gender = COALESCE($3, gender), 
                    bio = COALESCE($4, bio)
                WHERE id = $5;
            `;
            await pool.query(query, [username, age, gender, bio, userId]);
            res.status(200).json({ success: true, message: 'Perfil actualizado con éxito.' });
        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({ success: false, message: 'El nombre de usuario ya está en uso.' });
            }
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno al actualizar el perfil.' });
        }
    });

    // ----------------------------------------------------
    // RUTA: Subir Foto de Perfil
    // ----------------------------------------------------
    router.post('/upload-profile-pic', 
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadMiddleware,
        processImage('profile'),
        async (req, res) => {
            if (!req.file) return res.status(400).json({ success: false, message: 'No se subió ningún archivo.' });
            
            const publicPath = `/uploads/profile_images/${req.file.filename}`;
            try {
                await pool.query('UPDATE usersapp SET profile_pic_url = $1 WHERE id = $2', [publicPath, req.user.userId]);
                res.status(200).json({ success: true, message: 'Foto de perfil actualizada.', profilePicUrl: publicPath });
            } catch (error) {
                console.error(error.stack);
                res.status(500).json({ success: false, message: 'Error al guardar la URL del perfil.' });
            }
        });


      // ----------------------------------------------------
    // NUEVA RUTA: Subir Foto de Portada
    // ----------------------------------------------------
    router.post('/upload-cover-pic', 
        (req, res, next) => protect(req, res, next, JWT_SECRET), // 1. Proteger ruta
        uploadCoverMiddleware,                                   // 2. Multer sube a memoria
        processImage('cover'),                                   // 3. Sharp procesa y guarda como .webp
        async (req, res) => {
            if (!req.file) {
                return res.status(400).json({ success: false, message: 'No se subió ningún archivo.' });
            }
            
            // 4. Construir la URL pública y guardar en la BD
            const publicPath = `/uploads/cover_images/${req.file.filename}`;
            try {
                await pool.query('UPDATE usersapp SET cover_pic_url = $1 WHERE id = $2', [publicPath, req.user.userId]);
                res.status(200).json({ 
                    success: true, 
                    message: 'Foto de portada actualizada.', 
                    coverPicUrl: publicPath 
                });
            } catch (error) {
                console.error(error.stack);
                res.status(500).json({ success: false, message: 'Error al guardar la URL de la portada.' });
            }
        });


        
    // ----------------------------------------------------
    // NUEVA RUTA: Seguir / Dejar de seguir a un usuario
    // ----------------------------------------------------
    router.post('/follow/:userId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const followerId = req.user.userId;
        const followingId = parseInt(req.params.userId, 10);

        if (isNaN(followingId)) {
            return res.status(400).json({ success: false, message: 'El ID de usuario a seguir no es válido.' });
        }
        if (followerId === followingId) {
            return res.status(400).json({ success: false, message: 'No puedes seguirte a ti mismo.' });
        }

        try {
            const deleteQuery = 'DELETE FROM followersapp WHERE follower_id = $1 AND following_id = $2';
            const deleteResult = await pool.query(deleteQuery, [followerId, followingId]);

            if (deleteResult.rowCount > 0) {
                return res.status(200).json({ success: true, action: 'unfollowed', message: 'Has dejado de seguir a este usuario.' });
            }

            const insertQuery = 'INSERT INTO followersapp (follower_id, following_id) VALUES ($1, $2)';
            await pool.query(insertQuery, [followerId, followingId]);

            return res.status(201).json({ success: true, action: 'followed', message: 'Ahora sigues a este usuario.' });

        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno al procesar la solicitud de seguimiento.' });
        }
    });

    return router;
};