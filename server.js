// Archivo: /server/server.js (VERSIÓN CON CORS MANUAL)
// Carga las variables de entorno del archivo .env
require('dotenv').config({ path: './.env' }); 
const fs = require('fs'); // <-- ¡AÑADE ESTA IMPORTACIÓN!

const express = require('express');
// const cors = require('cors'); // Ya no se necesita
const { Pool } = require('pg');
const path = require('path');
// const bodyParser = require('body-parser'); // Usaremos el de Express integrado
const http = require('http'); // <-- AÑADE ESTA LÍNEA
const { Server } = require("socket.io"); // <-- AÑADE ESTA LÍNEA
const admin = require('firebase-admin'); // <-- 1. IMPORTA FIREBASE ADMIN

// --- ¡AÑADE ESTA LÍNEA PARA HACER PETICIONES HTTP DESDE EL BACKEND! ---
const fetch = require('node-fetch');
const app = express();
const PORT = 3001;
const INTERNAL_HOST = '0.0.0.0'; 

// CLAVE SECRETA DE JWT (¡USAR .ENV EN PRODUCCIÓN!)
const JWT_SECRET = 'TuSuperClaveSecretaJWT9876543210'; 

// --- CREA UN SERVIDOR HTTP Y ENVUELVE TU APP DE EXPRESS ---
const server = http.createServer(app);

// --- CONFIGURA SOCKET.IO CON CORS ---
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    // ¡LA LÍNEA CLAVE!
    path: "/app/socket.io/"
});

// ==========================================================
// === ¡AQUÍ ESTÁ LA LÍNEA MÁGICA QUE SOLUCIONA EL BUG! ===
// ==========================================================
app.set('socketio', io);
// ==========================================================

// ==========================================================
// === INICIALIZACIÓN DE FIREBASE ADMIN (SOLO UNA VEZ) ===
// ==========================================================
try {
    const serviceAccount = require('./config/firebase-service-account.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK inicializado correctamente.');
} catch (error) {
    console.error('❌ Error al inicializar Firebase Admin SDK:', error.message);
    // Podrías decidir salir del proceso si Firebase es crítico
    // process.exit(1); 
}
// ==========================================================


// ====================================================
// CONFIGURACIÓN DE BASE DE DATOS (POSTGRESQL)
// ====================================================
if (!process.env.DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL no está definido en el archivo .env');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

pool.connect()
    .then(client => {
        console.log('✅ Conexión exitosa a PostgreSQL.');
        client.release();
    })
    .catch(err => {
        console.error('❌ Error de conexión a PostgreSQL:', err.stack);
        process.exit(1);
    });

// ====================================================
// CONFIGURACIÓN DE MIDDLEWARE
// ====================================================

// Aumentamos el límite del cuerpo de la solicitud para poder subir videos grandes.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));


// ====================================================
// CONFIGURACIÓN DE MIDDLEWARE (VERSIÓN FINAL Y SIMPLIFICADA)
// ====================================================

// Solo necesitamos el parser para cuerpos de solicitud grandes.
// Nginx se encargará de todo lo relacionado con CORS.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Servir archivos estáticos (sin cambios)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
// --- ¡AÑADE ESTA LÍNEA PARA SERVIR LA CARPETA DE ACTUALIZACIONES! ---
    app.use('/updates', express.static(path.join(__dirname, 'public', 'updates')));
 // ==========================================================
    // === ¡NUEVA RUTA PARA LA VERSIÓN DE LA APP! ===
    // ==========================================================
    const appRouter = express.Router();
    appRouter.get('/latest-version', (req, res) => {
        const versionFilePath = path.join(__dirname, 'public', 'updates', 'version.json');
        fs.readFile(versionFilePath, 'utf8', (err, data) => {
            if (err) {
                console.error("Error al leer version.json:", err);
                return res.status(500).json({ success: false, message: "No se pudo obtener la información de la versión." });
            }
            const versionInfo = JSON.parse(data);
            // Añadimos la URL de descarga para que el cliente no tenga que construirla
            versionInfo.downloadUrl = `${process.env.PUBLIC_SERVER_URL}/updates/app-release.apk`;
            res.json({ success: true, ...versionInfo });
        });
    });

// --- CREA UN MAPA PARA RASTREAR USUARIOS EN LÍNEA ---
const onlineUsers = new Map(); // K: socket.id, V: userId
app.set('onlineUsers', onlineUsers); // Hacemos el mapa accesible en las rutas

// --- LÓGICA DE WEBSOCKETS (Pega esto después de tus middlewares) ---
io.on('connection', (socket) => {
    console.log('🔌 Un usuario se ha conectado:', socket.id);

    const notifyFriendsOfStatusChange = async (userId, isOnline, currentAppInfo = null) => {
        console.log(`📢 BACKEND-STATUS: Intentando notificar a amigos de User ${userId}. Estado: ${isOnline}, App: ${currentAppInfo ? currentAppInfo.name : null}`);
        try {
            const query = `
                SELECT f1.follower_id as friend_id
                FROM followersapp f1
                INNER JOIN followersapp f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id
                WHERE f1.following_id = $1;
            `;
            const result = await pool.query(query, [userId]);
            const friends = result.rows;
            
            if (friends.length === 0) {
                console.log(`🟡 BACKEND-STATUS: User ${userId} no tiene amigos para notificar.`);
                return;
            }

            // ==========================================================
            // === ¡AQUÍ ESTÁ LA CORRECCIÓN! ===
            // ==========================================================
            // Usamos la variable correcta 'currentAppInfo' que recibe la función.
            const payload = { 
                userId: userId, 
                isOnline: isOnline,
                currentApp: currentAppInfo ? currentAppInfo.name : null,
                currentAppIcon: currentAppInfo ? currentAppInfo.icon : null,
                currentAppPackage: currentAppInfo ? currentAppInfo.package : null
            };
            // ==========================================================
            
            console.log('➡️ BACKEND-STATUS: Preparando para emitir el payload:', payload);

            friends.forEach(friend => {
                const friendRoom = `user-${friend.friend_id}`;
                io.to(friendRoom).emit('friend_status_update', payload);
                console.log(`  -> Emitiendo a la sala ${friendRoom}`);
            });
        } catch (error) {
            console.error("❌ BACKEND-STATUS: Error en notifyFriendsOfStatusChange:", error);
        }
    };

    socket.on('authenticate', (token) => {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.userId) {
                const userId = decoded.userId;
                
                // Asociamos el userId con el socket
                socket.userId = userId; // <-- AÑADIMOS EL userId DIRECTAMENTE AL OBJETO SOCKET

                const userRoom = `user-${userId}`;
                socket.join(userRoom);
                onlineUsers.set(socket.id, { userId: userId, currentApp: null });
                console.log(`✅ Socket ${socket.id} autenticado como user ${userId} y unido a la sala ${userRoom}`);
                
                notifyFriendsOfStatusChange(userId, true, null);
            }
        } catch (error) {
            console.log(`❌ Fallo de autenticación para socket ${socket.id}`);
        }
    });

     socket.on('update_current_app', async (appData) => {
        if (!socket.userId) return;

        // --- LOG 5: Confirmar la recepción del evento en el backend ---
        console.log(`[SERVER LOG] Evento 'update_current_app' RECIBIDO de User ${socket.userId}. Data:`, appData);

        let finalAppData = null;
        if (appData && appData.package) {
            try {
                const result = await pool.query('SELECT * FROM detected_apps WHERE package_name = $1', [appData.package]);
                
                if (result.rows.length > 0) {
                    const dbApp = result.rows[0];
                    finalAppData = { 
                        name: dbApp.app_name, 
                        package: dbApp.package_name, 
                        icon: dbApp.icon_url, 
                        is_game: dbApp.is_game 
                    };

                    // --- LOG 6: Confirmar que se está intentando guardar en el historial ---
                    console.log(`[SERVER LOG] App encontrada en BD: '${dbApp.app_name}'. Intentando registrar en historial...`);
                try {
                        // Siempre actualizamos el historial de apps vistas por el usuario
                    const upsertHistoryQuery = `
                        INSERT INTO user_app_history (user_id, package_name, last_seen_at)
                        VALUES ($1, $2, CURRENT_TIMESTAMP)
                        ON CONFLICT (user_id, package_name)
                        DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP;
                    `;
                    await pool.query(upsertHistoryQuery, [socket.userId, dbApp.package_name]);
                    console.log(`[SERVER LOG] ¡Éxito! Historial actualizado para User ${socket.userId}.`);
                    
                    if (dbApp.is_game === true) {
                            const upsertGameQuery = `
                                INSERT INTO user_played_games (user_id, package_name, last_played_at)
                                VALUES ($1, $2, CURRENT_TIMESTAMP)
                                ON CONFLICT (user_id, package_name)
                                DO UPDATE SET last_played_at = CURRENT_TIMESTAMP;
                            `;
                            await pool.query(upsertGameQuery, [socket.userId, dbApp.package_name]);
                            console.log(`🕹️  [DB LOG] Juego registrado/actualizado para User ${socket.userId}: ${dbApp.package_name}`);
                        }
                    } catch(dbError) {
                        console.error(`❌ [DB LOG] Error al registrar historial/juego para User ${socket.userId}:`, dbError);
                    }

                } else {
                    // Si la app NO existe en nuestra base de datos
                    finalAppData = { 
                        name: appData.name, 
                        package: appData.package, 
                        icon: null, 
                        unregistered: true 
                    };
                }
            } catch (dbError) {
                console.error("❌ Error al buscar app en la BD:", dbError);
                // Si la BD falla, usamos el nombre nativo como fallback.
                finalAppData = { name: appData.name, package: appData.package, icon: null };
            }
        }

        // --- PASO 3: Lógica de Notificación a Amigos (SOLO si la app cambió) ---
        // Obtenemos el estado actual del usuario del mapa en memoria.
        const userData = onlineUsers.get(socket.id);
        
        // Comparamos el paquete de la app anterior con el de la nueva.
        if (userData && (userData.currentApp?.package !== finalAppData?.package)) {
            console.log(`🔄 [STATE CHANGE] User ${socket.userId} cambió de app: ${userData.currentApp?.package || 'ninguna'} -> ${finalAppData?.package || 'ninguna'}`);
            
            // Actualizamos el mapa en memoria con la nueva app.
            userData.currentApp = finalAppData;
            onlineUsers.set(socket.id, userData);
            
            // Notificamos a los amigos sobre el cambio de estado.
            notifyFriendsOfStatusChange(socket.userId, true, finalAppData);
        }
    });





    // El cliente se une a una sala privada al conectarse
    socket.on('join_room', (roomName) => {
        socket.join(roomName);
        console.log(`Socket ${socket.id} se unió a la sala: ${roomName}`);
    });

    // Escucha los mensajes entrantes del cliente
    socket.on('send_message', async (data) => {
        // Obtenemos los datos del cliente, incluyendo el ID temporal
        const { sender_id, receiver_id, content, roomName, parent_message_id, message_id: tempId } = data;

        try {
            // 1. Guardar el nuevo mensaje en la base de datos
            const insertQuery = 'INSERT INTO messagesapp (sender_id, receiver_id, content, parent_message_id) VALUES ($1, $2, $3, $4) RETURNING *';
            const insertResult = await pool.query(insertQuery, [sender_id, receiver_id, content, parent_message_id || null]);
            let savedMessage = insertResult.rows[0]; // Usamos 'let' para poder modificar el objeto

            // =========================================================
            // === INICIO DE LA LÓGICA DE "ENRIQUECIMIENTO" ===
            // =========================================================
            // 2. Si el mensaje que acabamos de guardar es una respuesta...
            if (savedMessage.parent_message_id) {
                // ...hacemos una consulta extra para obtener los datos del mensaje original.
                const parentQuery = `
                    SELECT 
                        p.content as parent_content,
                        pu.username as parent_username
                    FROM messagesapp AS p
                    JOIN usersapp AS pu ON p.sender_id = pu.id
                    WHERE p.message_id = $1;
                `;
                const parentResult = await pool.query(parentQuery, [savedMessage.parent_message_id]);
                
                if (parentResult.rows.length > 0) {
                    // Añadimos las propiedades 'parent_content' y 'parent_username'
                    // al objeto 'savedMessage' antes de enviarlo.
                    savedMessage.parent_content = parentResult.rows[0].parent_content;
                    savedMessage.parent_username = parentResult.rows[0].parent_username;
                }
            }
            // =========================================================
            // === FIN DE LA LÓGICA DE "ENRIQUECIMIENTO" ===
            // =========================================================

            // 3. Emitimos el mensaje (ahora "enriquecido") al otro usuario en la sala
            socket.to(roomName).emit('receive_message', savedMessage);

            // 4. Enviamos la confirmación al emisor original con el mismo objeto enriquecido
            socket.emit('message_confirmed', {
                tempId: tempId,
                realMessage: savedMessage
            });
            // ==========================================================
            // === ¡NUEVA LÓGICA DE NOTIFICACIÓN PUSH PARA MENSAJES! ===
            // ==========================================================
            try {
                // A. Obtener los datos del destinatario (token FCM) y del remitente (nombre, foto)
                const recipientResult = await pool.query('SELECT fcm_token FROM usersapp WHERE id = $1', [receiver_id]);
                const senderResult = await pool.query('SELECT username, profile_pic_url FROM usersapp WHERE id = $1', [sender_id]);

                const recipient = recipientResult.rows[0];
                const sender = senderResult.rows[0];

                // B. Si el destinatario tiene un token FCM, enviar la notificación
                if (recipient && recipient.fcm_token) {
    
                    // CONSTRUIMOS EL PAYLOAD DE "SOLO DATOS"
                    const message = {
                        token: recipient.fcm_token,
                        // ¡¡¡ELIMINAMOS EL CAMPO "notification"!!!
                        
                        // Toda la información visual va DENTRO del campo "data"
                        data: {
                            // Datos para que el cliente construya la notificación
                            title: sender.username,
                            body: content,
                            channelId: 'chat_messages_channel', // Le decimos qué canal usar
                            
                            // Datos para el agrupamiento
                            groupId: String(sender_id), // El ID del remitente es el grupo
                            
                            // Datos para la acción de clic
                            senderId: String(sender_id),
                            openUrl: `chat.html?userId=${sender_id}` 
                        },
                        
                        // Podemos seguir usando las opciones de Android para la prioridad
                        android: {
                            priority: 'high' // Asegura la entrega rápida
                        }
                    };
                    
                    // Añadir la imagen de perfil (sin cambios)
                    if (sender.profile_pic_url) {
                        const fullImageUrl = (process.env.PUBLIC_SERVER_URL + sender.profile_pic_url).trim();
                        // La enviamos solo en el campo `data`
                        message.data.imageUrl = fullImageUrl;
                    }

                    await admin.messaging().send(message);
                    console.log(`Notificación de DATOS de mensaje enviada al usuario ${receiver_id}`);
                }
            } catch (pushError) {
                console.error("Error al enviar la notificación push del mensaje:", pushError);
            }
            // ==========================================================

        } catch (error) {
            console.error("Error al guardar o enviar el mensaje:", error);
        }
    });



    socket.on('disconnect', () => {
        console.log(`🔌 Un usuario se ha desconectado: ${socket.id}`);
        if (socket.userId) { // Usamos la propiedad que adjuntamos
            onlineUsers.delete(socket.id);
            notifyFriendsOfStatusChange(socket.userId, false, null);
        }
    });
    });




// ====================================================
// INICIALIZACIÓN DE TABLAS
// ====================================================

async function initDatabase() {
    // TABLA DE USUARIOS (usersapp)
    const usersQuery = `
        CREATE TABLE IF NOT EXISTS usersapp (
            id SERIAL PRIMARY KEY,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255),
            created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            username VARCHAR(50) UNIQUE,           
            age INTEGER,
            gender VARCHAR(10),
            profile_pic_url VARCHAR(255)
        );
    `;

    // TABLA DE PUBLICACIONES (postapp)
    const postQuery = `
        CREATE TABLE IF NOT EXISTS postapp (
            post_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            content TEXT,
            image_url VARCHAR(255),
            video_id VARCHAR(255), -- Columna para el ID de video de YouTube
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // TABLA DE REACCIONES (post_reactionapp)
    const reactionQuery = `
        CREATE TABLE IF NOT EXISTS post_reactionapp (
            reaction_id SERIAL PRIMARY KEY,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            reaction_type VARCHAR(10) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (post_id, user_id)
        );
    `;

    // TABLA DE POSTS GUARDADOS (saved_postsapp)
    const savedQuery = `
        CREATE TABLE IF NOT EXISTS saved_postsapp (
            saved_post_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, post_id)
        );
    `;

    // TABLA DE COMENTARIOS (commentsapp)
    const commentsQuery = `
        CREATE TABLE IF NOT EXISTS commentsapp (
            comment_id SERIAL PRIMARY KEY,
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE NOT NULL,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            parent_comment_id INTEGER REFERENCES commentsapp(comment_id) ON DELETE CASCADE,
            content TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // TABLA DE SEGUIDORES (followersapp)
    const followersQuery = `
        CREATE TABLE IF NOT EXISTS followersapp (
            follower_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            following_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (follower_id, following_id)
        );
    `;

    // --- AÑADE ESTE BLOQUE COMPLETO ---
    const messagesQuery = `
        CREATE TABLE IF NOT EXISTS messagesapp (
            message_id SERIAL PRIMARY KEY,
            sender_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            receiver_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    // --- FIN DEL BLOQUE A AÑADIR ---

    // TABLA DE NOTIFICACIONES (notificationsapp)
    const notificationsQuery = `
        CREATE TABLE IF NOT EXISTS notificationsapp (
            notification_id SERIAL PRIMARY KEY,
            recipient_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL, -- Quién recibe la notificación
            sender_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,    -- Quién la originó
            type VARCHAR(20) NOT NULL, -- 'new_follower', 'like', 'comment'
            post_id INTEGER REFERENCES postapp(post_id) ON DELETE CASCADE, -- Opcional, para likes/comentarios
            is_read BOOLEAN DEFAULT FALSE NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;
    
    // AÑADE ESTA QUERY
     // AÑADE ESTA QUERY
    const detectedAppsQuery = `
        CREATE TABLE IF NOT EXISTS detected_apps (
            package_name VARCHAR(255) PRIMARY KEY,
            app_name VARCHAR(100) NOT NULL,
            icon_url VARCHAR(255),
            added_by_user_id INTEGER REFERENCES usersapp(id),
            is_game BOOLEAN DEFAULT NULL, -- <-- ¡NUEVA COLUMNA!
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

     // ==========================================================
    // === ¡NUEVA TABLA PARA REGISTRAR JUEGOS JUGADOS! ===
    // ==========================================================
    const userPlayedGamesQuery = `
        CREATE TABLE IF NOT EXISTS user_played_games (
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            package_name VARCHAR(255) REFERENCES detected_apps(package_name) ON DELETE CASCADE NOT NULL,
            last_played_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, package_name)
        );
    `;
    // ==========================================================

    
     // ==========================================================
    // === ¡NUEVA TABLA PARA EL HISTORIAL DE APPS DEL USUARIO! ===
    // ==========================================================
    const userAppHistoryQuery = `
        CREATE TABLE IF NOT EXISTS user_app_history (
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            package_name VARCHAR(255) REFERENCES detected_apps(package_name) ON DELETE CASCADE NOT NULL,
            last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, package_name)
        );
    `;
    // ==========================================================
    // ==========================================================
    // === ¡NUEVA TABLA PARA LAS TARJETAS DE JUGADOR! ===
    // ==========================================================
    const playerCardsQuery = `
        CREATE TABLE IF NOT EXISTS player_cards (
            card_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES usersapp(id) ON DELETE CASCADE NOT NULL,
            package_name VARCHAR(255) REFERENCES detected_apps(package_name) ON DELETE CASCADE NOT NULL,
            in_game_username VARCHAR(100),
            in_game_id VARCHAR(100),
            invite_link TEXT,
            cover_image_url VARCHAR(255),
            
            -- ¡NUEVA COLUMNA PARA EL ORDEN! --
            display_order INTEGER NOT NULL DEFAULT 0,

            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, package_name)
        );
    `;
    // ==========================================================

    try {
        await pool.query(usersQuery);
        console.log('✅ Tabla "usersapp" verificada/creada.');
        await pool.query(postQuery);
        console.log('✅ Tabla "postapp" verificada/creada.');
        await pool.query(reactionQuery);
        console.log('✅ Tabla "post_reactionapp" verificada/creada.');
        await pool.query(savedQuery);
        console.log('✅ Tabla "saved_postsapp" verificada/creada.');
        await pool.query(commentsQuery);
        console.log('✅ Tabla "commentsapp" verificada/creada.');
        await pool.query(followersQuery);
        console.log('✅ Tabla "followersapp" verificada/creada.');
        // --- AÑADE ESTA LÍNEA ---
        await pool.query(messagesQuery);
        console.log('✅ Tabla "messagesapp" verificada/creada.');
        
        await pool.query(notificationsQuery);
        console.log('✅ Tabla "notificationsapp" verificada/creada.');
        
        // AÑADE ESTA LLAMADA
        await pool.query(detectedAppsQuery);
        console.log('✅ Tabla "detected_apps" verificada/creada.');
    
        // --- AÑADE ESTA LLAMADA ---
        await pool.query(userPlayedGamesQuery);
        console.log('✅ Tabla "user_played_games" verificada/creada.');

        // --- AÑADE ESTA LLAMADA ---
        await pool.query(userAppHistoryQuery);
        console.log('✅ Tabla "user_app_history" verificada/creada.');
        // --- AÑADE ESTA LLAMADA ---
        await pool.query(playerCardsQuery);
        console.log('✅ Tabla "player_cards" verificada/creada.');
    } catch (err) {
        console.error('❌ Error al inicializar la base de datos:', err.stack);
    }
}
initDatabase();


// Rutas
const authRoutes = require('./api/auth');
const userRoutes = require('./api/user'); 
const postRoutes = require('./api/post');
const chatRoutes = require('./api/chat');
const notificationRoutes = require('./api/notifications');
const appRoutes = require('./api/apps');

// ==========================================================
// === ¡ORDEN DE RUTAS CORREGIDO! ===
// ==========================================================
// Montamos las rutas más específicas primero.
app.use('/api/auth', authRoutes(pool, JWT_SECRET)); 
app.use('/api/posts', postRoutes(pool, JWT_SECRET));
app.use('/api/notifications', notificationRoutes(pool, JWT_SECRET));
app.use('/api/apps', appRoutes(pool, JWT_SECRET)); // <-- `apps` va ANTES que `user`
app.use('/api/chat', chatRoutes(pool, JWT_SECRET, io));

// La ruta genérica `/api/user/:userId` va al final para no interceptar otras.
app.use('/api/user', userRoutes(pool, JWT_SECRET)); 

app.use('/api/app', appRouter);

// ==========================================================

// --- AÑADE LA NUEVA RUTA ---
// ==========================================================
// === ¡AQUÍ ESTÁ LA CORRECCIÓN EN EL SERVIDOR! ===
// ==========================================================
// Montamos todas nuestras rutas bajo el prefijo '/api'
const apiRouter = express.Router();


// Y ahora montamos este router principal en la raíz de la app.
// Cuando el proxy redirija a /app, Express verá la ruta como si fuera solo '/'.
app.use(apiRouter);
// ==========================================================
// Manejador de Errores Final
app.use((err, req, res, next) => {
    console.error(err.stack);
    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    res.status(statusCode).json({
        success: false,
        message: err.message || 'Error interno del servidor.',
    });
});

// Servidor de escucha
const PRODUCTION_API_URL = 'https://davcenter.servequake.com';
server.listen(PORT, INTERNAL_HOST, () => {
    console.log(`📡 Servidor de Node.js escuchando INTERNAMENTE en ${INTERNAL_HOST}:${PORT}`);
    console.log(`🌐 Acceso EXTERNO (APP) vía: ${PRODUCTION_API_URL}`);
});