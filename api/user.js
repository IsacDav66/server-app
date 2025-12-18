// Archivo: /server/api/user.js (VERSIÓN COMPLETA Y CORREGIDA)

const express = require('express');
const sanitizeHtml = require('sanitize-html'); // <-- 1. IMPORTAR SANITIZER
const { protect, softProtect } = require('../middleware/auth'); 
const uploadMiddleware = require('../middleware/upload');
const uploadCoverMiddleware = require('../middleware/uploadCover');
const uploadBioImageMiddleware = require('../middleware/uploadBioImage'); // <-- 2. IMPORTAR NUEVO MIDDLEWARE
const processImage = require('../middleware/processImage');
const uploadPlayerCardCoverMiddleware = require('../middleware/uploadPlayerCardCover');

const path = require('path');
// EN LA PARTE SUPERIOR DEL ARCHIVO, JUNTO A LOS OTROS REQUIRES
const admin = require('firebase-admin'); // <-- SOLO NECESITAS IMPORTARLO


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
    // RUTA PÚBLICA: Obtener datos de perfil de CUALQUIER usuario (VERSIÓN MEJORADA)
    router.get('/profile/:userId', (req, res, next) => softProtect(req, res, next, JWT_SECRET), async (req, res) => {
        const userId = parseInt(req.params.userId, 10);
        const loggedInUserId = req.user ? req.user.userId : null;

        if (isNaN(userId)) return res.status(400).json({ success: false, message: 'El ID de usuario no es válido.' });

        try {
            // Consulta mejorada con una subconsulta para obtener el último juego
            const query = `
                SELECT 
                    u.id, u.username, u.profile_pic_url, u.bio, u.cover_pic_url, u.bio_bg_url,
                    (SELECT COUNT(*) FROM postapp WHERE user_id = u.id) AS post_count,
                    (SELECT COUNT(*) FROM followersapp WHERE following_id = u.id) AS followers_count,
                    (SELECT COUNT(*) FROM followersapp WHERE follower_id = u.id) AS following_count,
                    EXISTS(SELECT 1 FROM followersapp WHERE follower_id = $2 AND following_id = $1) AS is_followed_by_user,
                    
                    -- Subconsulta para obtener el nombre y la fecha del último juego jugado
                    (SELECT da.app_name 
                    FROM user_played_games upg
                    JOIN detected_apps da ON upg.package_name = da.package_name
                    WHERE upg.user_id = $1
                    ORDER BY upg.last_played_at DESC
                    LIMIT 1) AS last_played_game,
                    
                    (SELECT upg.last_played_at
                    FROM user_played_games upg
                    WHERE upg.user_id = $1
                    ORDER BY upg.last_played_at DESC
                    LIMIT 1) AS last_played_at

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


    // RUTA PARA REGISTRAR O ACTUALIZAR EL TOKEN FCM
router.post('/fcm-token', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const { token } = req.body;
    const userId = req.user.userId;

    if (!token) {
        return res.status(400).json({ success: false, message: 'No se proporcionó ningún token.' });
    }

    try {
        const query = 'UPDATE usersapp SET fcm_token = $1 WHERE id = $2';
        await pool.query(query, [token, userId]);
        res.status(200).json({ success: true, message: 'Token FCM actualizado.' });
    } catch (error) {
        console.error('Error al guardar el token FCM:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});
    // ----------------------------------------------------
    // NUEVA RUTA: Seguir / Dejar de seguir a un usuario
    // ----------------------------------------------------
    // --- RUTA DE SEGUIMIENTO CON PAYLOAD DE NOTIFICACIÓN UNIFICADO ---
    router.post('/follow/:userId', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const followerId = req.user.userId;
        const followingId = parseInt(req.params.userId, 10);

        if (isNaN(followingId) || followerId === followingId) {
            return res.status(400).json({ success: false, message: 'Solicitud inválida.' });
        }

        try {
            // Lógica de "Dejar de Seguir" (sin cambios)
            const deleteResult = await pool.query('DELETE FROM followersapp WHERE follower_id = $1 AND following_id = $2', [followerId, followingId]);
            if (deleteResult.rowCount > 0) {
                return res.status(200).json({ success: true, action: 'unfollowed' });
            }

            // Lógica de "Seguir" (sin cambios)
            await pool.query('INSERT INTO followersapp (follower_id, following_id) VALUES ($1, $2)', [followerId, followingId]);
            
            const senderData = (await pool.query('SELECT username, profile_pic_url FROM usersapp WHERE id = $1', [followerId])).rows[0];

            // 4. Lógica de Notificación DENTRO DE LA APP (Socket.IO)
            try {
                const notifQuery = `INSERT INTO notificationsapp (recipient_id, sender_id, type) VALUES ($1, $2, 'new_follower') RETURNING *;`;
                const notifResult = await pool.query(notifQuery, [followingId, followerId]);
                
                const notificationPayload = {
                    ...notifResult.rows[0],
                    sender_username: senderData.username,
                    sender_profile_pic_url: senderData.profile_pic_url
                };

                const io = req.app.get('socketio');
                const userRoom = `user-${followingId}`;
                io.to(userRoom).emit('new_notification', notificationPayload);
                console.log(`Notificación en-app enviada a la sala ${userRoom}`);
            } catch (inAppNotifError) {
                console.error("Error al procesar la notificación en la app (Socket.IO):", inAppNotifError);
            }

            // 5. Lógica de NOTIFICACIÓN PUSH (Firebase Cloud Messaging) con imagen
            // --- LÓGICA DE NOTIFICACIÓN PUSH (CON ESTRUCTURA CORREGIDA) ---
            try {
                const tokenResult = await pool.query('SELECT fcm_token FROM usersapp WHERE id = $1', [followingId]);
                const userToNotify = tokenResult.rows[0];

                if (userToNotify && userToNotify.fcm_token) {
                    
                    // ==========================================================
                    // === ¡AQUÍ ESTÁ LA CORRECCIÓN ESTRUCTURAL! ===
                    // ==========================================================
                    // Construimos un payload de "SOLO DATOS", sin el campo "notification".
                    const message = {
                        token: userToNotify.fcm_token,
                        data: {
                            // Datos para que el cliente construya la notificación
                            title: '¡Nuevo Seguidor!',
                            body: `${senderData.username} ha comenzado a seguirte.`,
                            
                            // Los campos que faltaban y que nuestro servicio Java requiere
                            channelId: 'followers_channel', // El ID del canal para seguidores
                            groupId: `followers-${followingId}`, // Un ID de grupo para todas las notificaciones de seguidor de este usuario

                            // Datos adicionales para la acción de clic y el icono
                            senderId: String(followerId),
                            openUrl: `user_profile.html?id=${followerId}`
                        },
                        android: {
                            priority: 'high'
                        }
                    };
                    // ==========================================================

                    // Añadir la URL de la imagen directamente al campo `data`
                    if (senderData.profile_pic_url) {
                        const fullImageUrl = (process.env.PUBLIC_SERVER_URL + senderData.profile_pic_url).trim();
                        message.data.imageUrl = fullImageUrl;
                    }
                    
                    await admin.messaging().send(message);
                    console.log(`Notificación de DATOS de seguidor enviada al usuario ${followingId}`);
                }
            } catch (pushError) {
                console.error("❌ PUSH: Error al enviar la notificación push de seguidor:", pushError);
            }
            
            return res.status(201).json({ success: true, action: 'followed' });

        } catch (error) {
            console.error('❌ Error crítico en la ruta /follow:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
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



  // =============================================================
// === NUEVAS RUTAS: OBTENER LISTAS DE SEGUIDORES / SEGUIDOS ===
// =============================================================

// Ruta para obtener la lista de SEGUIDORES de un usuario
router.get('/:userId/followers', (req, res, next) => softProtect(req, res, next, JWT_SECRET), async (req, res) => {
    const targetUserId = parseInt(req.params.userId);
    const loggedInUserId = req.user ? req.user.userId : null;

    if (isNaN(targetUserId)) return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });

    try {
        const query = `
            SELECT 
                u.id, 
                u.username, 
                u.profile_pic_url,
                -- Comprueba si el usuario logueado sigue a esta persona de la lista
                EXISTS(SELECT 1 FROM followersapp WHERE follower_id = $2 AND following_id = u.id) AS is_followed_by_user
            FROM usersapp u
            JOIN followersapp f ON u.id = f.follower_id
            WHERE f.following_id = $1;
        `;
        const result = await pool.query(query, [targetUserId, loggedInUserId]);
        res.status(200).json({ success: true, users: result.rows });
    } catch (error) {
        console.error('Error al obtener seguidores:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});

// Ruta para obtener la lista de personas que un usuario SIGUE (following)
router.get('/:userId/following', (req, res, next) => softProtect(req, res, next, JWT_SECRET), async (req, res) => {
    const targetUserId = parseInt(req.params.userId);
    const loggedInUserId = req.user ? req.user.userId : null;

    if (isNaN(targetUserId)) return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });
    
    try {
        const query = `
            SELECT 
                u.id, 
                u.username, 
                u.profile_pic_url,
                -- Comprueba si el usuario logueado sigue a esta persona de la lista
                EXISTS(SELECT 1 FROM followersapp WHERE follower_id = $2 AND following_id = u.id) AS is_followed_by_user
            FROM usersapp u
            JOIN followersapp f ON u.id = f.following_id
            WHERE f.follower_id = $1;
        `;
        const result = await pool.query(query, [targetUserId, loggedInUserId]);
        res.status(200).json({ success: true, users: result.rows });
    } catch (error) {
        console.error('Error al obtener seguidos:', error.stack);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});



// ==========================================================
    // === ¡NUEVA RUTA PARA OBTENER LA LISTA DE AMIGOS MUTUOS! ===
    // ==========================================================
    router.get('/friends', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const loggedInUserId = req.user.userId;

        try {
            // Esta consulta utiliza un INNER JOIN con la misma tabla para encontrar seguimientos recíprocos.
            const query = `
                SELECT
                    u.id,
                    u.username,
                    u.profile_pic_url
                FROM followersapp f1
                INNER JOIN followersapp f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
                JOIN usersapp u ON f1.following_id = u.id
                WHERE f1.follower_id = $1;
            `;
            
            const result = await pool.query(query, [loggedInUserId]);
            
            // Ahora, enriquecemos el resultado con el estado en línea
            const onlineUsers = req.app.get('onlineUsers'); // Obtenemos el mapa de usuarios en línea
            const friendsWithStatus = result.rows.map(friend => ({
                ...friend,
                is_online: Array.from(onlineUsers.values()).includes(friend.id)
            }));

            res.status(200).json({ success: true, friends: friendsWithStatus });
        } catch (error) {
            console.error('Error al obtener la lista de amigos:', error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

// RUTA PARA OBTENER SOLO LOS JUEGOS JUGADOS (CON LOGS DE DEPURACIÓN)
// RUTA PARA OBTENER SOLO LOS JUEGOS JUGADOS (CON CORRECCIÓN DE SINTAXIS)
router.get('/:userId/played-games', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
    const targetUserId = parseInt(req.params.userId);

    if (isNaN(targetUserId)) {
        return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });
    }

    try {
        const query = `
            SELECT
                da.app_name,
                da.package_name,
                da.icon_url
            FROM user_played_games upg
            JOIN detected_apps da ON upg.package_name = da.package_name
            WHERE upg.user_id = $1
            ORDER BY upg.last_played_at DESC;
        `;
        
        console.log(`[API /played-games] Buscando juegos para userId: ${targetUserId}`);
        const result = await pool.query(query, [targetUserId]);
        console.log(`[API /played-games] Filas encontradas en la BD: ${result.rowCount}`);
        
        res.status(200).json({ success: true, games: result.rows });
    } catch (error) { // <-- ¡LLAVES AÑADIDAS AQUÍ!
        console.error("Error al obtener los juegos jugados del usuario:", error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    } // <-- ¡LLAVES AÑADIDAS AQUÍ!
});
// ==========================================================


// ==========================================================
    // === ¡NUEVA RUTA PARA CREAR/ACTUALIZAR UNA TARJETA DE JUGADOR! ===
    // ==========================================================
    // RUTA PARA CREAR/ACTUALIZAR UNA TARJETA DE JUGADOR (VERSIÓN CORREGIDA)
    router.post('/player-cards',
        (req, res, next) => protect(req, res, next, JWT_SECRET),
        uploadPlayerCardCoverMiddleware,
        processImage('card_cover'),
        async (req, res) => {
            const userId = req.user.userId;
            const { packageName, inGameUsername, inGameId, inviteLink } = req.body;

            // ==========================================================
            // === ¡AQUÍ ESTÁ LA LÓGICA CORREGIDA! ===
            // ==========================================================
            // 1. Por defecto, usamos la URL de la imagen existente que nos envía el frontend.
            let coverImageUrl = req.body.existingCoverUrl || null;

            // 2. Si se subió un archivo NUEVO, sobrescribimos la URL con la nueva ruta.
            if (req.file) {
                coverImageUrl = `/uploads/card_cover_images/${req.file.filename}`;
            }
            // ==========================================================

            if (!packageName) {
                return res.status(400).json({ success: false, message: 'Falta el nombre del paquete del juego.' });
            }

            try {
                // La consulta UPSERT no necesita cambios, ya que usa la variable `coverImageUrl`
                const query = `
                    INSERT INTO player_cards (user_id, package_name, in_game_username, in_game_id, invite_link, cover_image_url, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                    ON CONFLICT (user_id, package_name)
                    DO UPDATE SET
                        in_game_username = EXCLUDED.in_game_username,
                        in_game_id = EXCLUDED.in_game_id,
                        invite_link = EXCLUDED.invite_link,
                        cover_image_url = EXCLUDED.cover_image_url,
                        updated_at = CURRENT_TIMESTAMP
                    RETURNING *;
                `;
                const result = await pool.query(query, [userId, packageName, inGameUsername, inGameId, inviteLink, coverImageUrl]);
                res.status(200).json({ success: true, message: 'Tarjeta de jugador guardada.', card: result.rows[0] });
            } catch (error) {
                console.error("Error al guardar la tarjeta de jugador:", error);
                res.status(500).json({ success: false, message: 'Error interno del servidor.' });
            }
        }
    );

    // ==========================================================
    // === ¡NUEVA RUTA PARA OBTENER LAS TARJETAS DE UN USUARIO! ===
    // ==========================================================
    // RUTA PARA OBTENER LAS TARJETAS DE UN USUARIO (MODIFICADA)
    router.get('/:userId/player-cards', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const targetUserId = parseInt(req.params.userId);
        if (isNaN(targetUserId)) return res.status(400).json({ success: false, message: 'ID de usuario inválido.' });

        try {
            const query = `
                SELECT 
                    pc.*,
                    da.app_name,
                    da.icon_url
                FROM player_cards pc
                JOIN detected_apps da ON pc.package_name = da.package_name
                WHERE pc.user_id = $1
                ORDER BY pc.display_order ASC; -- <-- ¡ORDENAMOS POR LA NUEVA COLUMNA!
            `;
            const result = await pool.query(query, [targetUserId]);
            res.status(200).json({ success: true, cards: result.rows });
        } catch (error) { /* ... */ }
    });

    // ==========================================================
    // === ¡NUEVA RUTA PARA GUARDAR EL ORDEN DE LAS TARJETAS! ===
    // ==========================================================
    router.post('/player-cards/reorder', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const userId = req.user.userId;
        const { orderedCardIds } = req.body;

        if (!Array.isArray(orderedCardIds)) {
            return res.status(400).json({ success: false, message: 'Se esperaba un array de IDs.' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const updatePromises = orderedCardIds.map((cardIdStr, index) => {
                // ==========================================================
                // === ¡AQUÍ ESTÁ LA VALIDACIÓN DE SEGURIDAD! ===
                // ==========================================================
                const cardId = parseInt(cardIdStr);

                // Si cardId no es un número válido, simplemente saltamos esta iteración.
                if (isNaN(cardId)) {
                    console.warn(`[REORDER WARN] Se recibió un cardId inválido: '${cardIdStr}'. Se ignora.`);
                    return Promise.resolve(); // Devuelve una promesa resuelta para no romper Promise.all
                }
                // ==========================================================
                
                const query = `
                    UPDATE player_cards 
                    SET display_order = $1 
                    WHERE card_id = $2 AND user_id = $3;
                `;
                return client.query(query, [index, cardId, userId]);
            });

            await Promise.all(updatePromises);

            await client.query('COMMIT');
            res.status(200).json({ success: true, message: 'Orden guardado.' });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error("Error al reordenar las tarjetas:", error);
            res.status(500).json({ success: false, message: 'Error interno al guardar el orden.' });
        } finally {
            client.release();
        }
    });


    return router;
};