// Archivo: /server/api/user.js (VERSIÓN COMPLETA Y CORREGIDA)

const express = require('express');
const sanitizeHtml = require('sanitize-html'); // <-- 1. IMPORTAR SANITIZER
const { protect, softProtect } = require('../middleware/auth'); 
const uploadMiddleware = require('../middleware/upload');
const uploadCoverMiddleware = require('../middleware/uploadCover');
const uploadBioImageMiddleware = require('../middleware/uploadBioImage'); // <-- 2. IMPORTAR NUEVO MIDDLEWARE
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
    // REEMPLAZA tu ruta /profile/:userId con esta
    router.get('/profile/:userId', (req, res, next) => softProtect(req, res, next, JWT_SECRET), async (req, res) => {
        const userId = parseInt(req.params.userId, 10);
        const loggedInUserId = req.user ? req.user.userId : null; // Obtenemos el ID del visitante

        if (isNaN(userId)) return res.status(400).json({ success: false, message: 'El ID de usuario no es válido.' });

        try {
            const query = `
                SELECT 
                    u.id, u.username, u.profile_pic_url, u.bio, u.cover_pic_url, u.bio_bg_url,
                    (SELECT COUNT(*) FROM postapp WHERE user_id = u.id) AS post_count,
                    (SELECT COUNT(*) FROM followersapp WHERE following_id = u.id) AS followers_count,
                    (SELECT COUNT(*) FROM followersapp WHERE follower_id = u.id) AS following_count,
                    -- ¡LA LÍNEA CLAVE! Comprueba si el usuario logueado sigue a este perfil
                    EXISTS(SELECT 1 FROM followersapp WHERE follower_id = $2 AND following_id = $1) AS is_followed_by_user
                FROM usersapp u
                WHERE u.id = $1;
            `;
            const result = await pool.query(query, [userId, loggedInUserId]);
            if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Perfil no encontrado.' });
            
            res.status(200).json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno al obtener el perfil.' });
        }
    });

   // ----------------------------------------------------
// RUTA: Actualizar/Completar Perfil (CON SANITIZACIÓN MEJORADA)
// ----------------------------------------------------
router.post('/complete-profile', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const { username, age, gender, bio } = req.body;
    const userId = req.user.userId;

    // --- CONFIGURACIÓN DE SANITIZACIÓN PARA QUILL.JS ---
    const cleanBio = bio ? sanitizeHtml(bio, {
        // 1. Permitir las etiquetas que usa Quill
        allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'span', 'p', 'h1', 'h2', 'h3']),
        
        // 2. Permitir los atributos 'class' y 'style'
        allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            'span': ['style', 'class'], // Permitir style y class en span
            'p': ['class'],            // Permitir class en p
            'img': ['src', 'width', 'height', 'style']
        },

        // 3. (CLAVE) Permitir CLASES específicas de Quill para tamaño y alineación
        allowedClasses: {
            'p': ['ql-align-center', 'ql-align-right', 'ql-align-justify'],
            'span': ['ql-size-small', 'ql-size-large', 'ql-size-huge']
        },

        // 4. (CLAVE) Permitir ESTILOS específicos para color y resaltado
        allowedStyles: {
            'span': {
              'color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/],
              'background-color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/]
            }
        }
    }) : null;

    try {
        const query = `
            UPDATE usersapp SET 
                username = COALESCE($1, username), 
                age = COALESCE($2, age), 
                gender = COALESCE($3, gender), 
                bio = COALESCE($4, bio)
            WHERE id = $5;
        `;
        await pool.query(query, [
            username || null, 
            age || null, 
            gender || null, 
            cleanBio,
            userId
        ]);
        
        res.status(200).json({ success: true, message: 'Perfil actualizado con éxito.' });

    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ success: false, message: 'El nombre de usuario ya está en uso.' });
        }
        console.error("Error al actualizar perfil:", error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});


    // --- 5. NUEVA RUTA: Para imágenes incrustadas en la biografía ---
    router.post('/upload-bio-image',
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadBioImageMiddleware,
        processImage('bio'),
        (req, res) => {
            if (!req.file) return res.status(400).json({ success: false, message: 'No se subió archivo.' });
            const publicPath = `/uploads/bio_images/${req.file.filename}`;
            res.status(200).json({ success: true, url: publicPath });
        }
    );


    // --- 6. NUEVA RUTA: Para la imagen de FONDO de la biografía ---
    router.post('/upload-bio-bg',
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadBioImageMiddleware, // Reutilizamos el mismo middleware de subida
        processImage('bio'),      // y de procesamiento
        async (req, res) => {
            if (!req.file) return res.status(400).json({ success: false, message: 'No se subió archivo.' });
            const publicPath = `/uploads/bio_images/${req.file.filename}`;
            try {
                await pool.query('UPDATE usersapp SET bio_bg_url = $1 WHERE id = $2', [publicPath, req.user.userId]);
                res.status(200).json({ success: true, url: publicPath });
            } catch (error) {
                console.error(error);
                res.status(500).json({ success: false, message: 'Error al guardar la URL de fondo.' });
            }
        }
    );

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

    // ====================================================
    // === NUEVA RUTA: BÚSQUEDA DE USUARIOS             ===
    // ====================================================
    router.get('/search', async (req, res) => {
        // Obtenemos el término de búsqueda de la query string (ej: ?q=Isac)
        const searchTerm = req.query.q;

        // Si no hay término de búsqueda, devolvemos un array vacío.
        if (!searchTerm || searchTerm.trim() === '') {
            return res.status(200).json({ success: true, users: [] });
        }

        try {
            // Preparamos el término de búsqueda para una consulta LIKE, insensible a mayúsculas/minúsculas.
            // Los '%' son comodines que significan "cualquier cosa".
            const searchQuery = `%${searchTerm}%`;

            // Consulta SQL segura usando parámetros ($1) para prevenir inyección SQL.
            const query = `
                SELECT id, username, profile_pic_url 
                FROM usersapp 
                WHERE username ILIKE $1 
                LIMIT 10;
            `;
            
            const result = await pool.query(query, [searchQuery]);

            res.status(200).json({ success: true, users: result.rows });

        } catch (error) {
            console.error('❌ Error en la búsqueda de usuarios:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor al buscar usuarios.' });
        }
    });

    // ====================================================
// === NUEVA RUTA: SEGUIR / DEJAR DE SEGUIR         ===
// ====================================================
router.post('/follow/:userId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const followerId = req.user.userId; // El que está logueado
    const followingId = parseInt(req.params.userId, 10); // Al que se quiere seguir

    if (isNaN(followingId) || followerId === followingId) {
        return res.status(400).json({ success: false, message: 'ID de usuario inválido o no puedes seguirte a ti mismo.' });
    }

    try {
        // Intentamos eliminar la relación primero (dejar de seguir)
        const deleteQuery = 'DELETE FROM followersapp WHERE follower_id = $1 AND following_id = $2';
        const deleteResult = await pool.query(deleteQuery, [followerId, followingId]);

        // Si se eliminó una fila, significa que ya lo seguía y ahora no.
        if (deleteResult.rowCount > 0) {
            return res.status(200).json({ success: true, action: 'unfollowed' });
        }

        // Si no se eliminó nada, significa que no lo seguía. Lo insertamos (seguir).
        const insertQuery = 'INSERT INTO followersapp (follower_id, following_id) VALUES ($1, $2)';
        await pool.query(insertQuery, [followerId, followingId]);

        return res.status(201).json({ success: true, action: 'followed' });

    } catch (error) {
        console.error('❌ Error al procesar la acción de seguir:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});
    return router;
};