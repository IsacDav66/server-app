// Archivo: /server/api/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); // <-- AÑADIDO
 const { OAuth2Client } = require('google-auth-library'); // <-- IMPORTAR

// La función principal exportada toma el pool y el JWT_SECRET
module.exports = (pool, JWT_SECRET) => {
    const router = express.Router();
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID); // <-- CREAR CLIENTE
    // ----------------------------------------------------
    // RUTA DE REGISTRO (/api/auth/register) - CON JWT
    // ----------------------------------------------------
    router.post('/register', async (req, res) => {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Falta correo o contraseña.' });
        }

        try {
            // 1. Hash de la contraseña
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(password, salt);

            // 2. Insertar nuevo usuario
            const query = 'INSERT INTO usersapp (email, password_hash) VALUES ($1, $2) RETURNING id';
            const result = await pool.query(query, [email, passwordHash]);

            const userId = result.rows[0].id;
            
            // 3. Crear TOKEN para iniciar sesión automáticamente
            const token = jwt.sign({ userId: userId }, JWT_SECRET, { expiresIn: '30d' });

            // 4. Respuesta (Devuelve el token)
            res.status(201).json({ 
                success: true, 
                message: 'Usuario registrado con éxito e iniciado sesión.',
                userId: userId,
                token: token // <-- DEVOLVER EL TOKEN
            });

        } catch (error) {
            if (error.code === '23505') {
                return res.status(409).json({ success: false, message: 'Ese correo ya está registrado.' });
            }
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });


    // ----------------------------------------------------
    // RUTA DE LOGIN (/api/auth/login) - CON JWT
    // ----------------------------------------------------
    router.post('/login', async (req, res) => {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: 'Falta correo o contraseña.' });
        }

        try {
            // 1. Buscar usuario
            const query = 'SELECT id, password_hash FROM usersapp WHERE email = $1';
            const result = await pool.query(query, [email]);

            if (result.rows.length === 0) {
                return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
            }

            const user = result.rows[0];

            // 2. Comparar contraseña
            const isValidPassword = await bcrypt.compare(password, user.password_hash);

            if (!isValidPassword) {
                return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
            }

            // 3. CREAR TOKEN
            const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
            
            // 4. Respuesta de éxito (Devuelve el token)
            res.status(200).json({ 
                success: true, 
                message: 'Inicio de sesión exitoso.', 
                userId: user.id,
                token: token // <-- DEVOLVER EL TOKEN
            });

        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error interno del servidor.' });
        }
    });

    // ====================================================
     // === NUEVA RUTA: INICIO DE SESIÓN CON GOOGLE      ===
     // ====================================================
     router.post('/google', async (req, res) => {
         const { token } = req.body;
         try {
             const ticket = await client.verifyIdToken({
                 idToken: token,
                 audience: process.env.GOOGLE_CLIENT_ID,
             });
             const { email, name, picture } = ticket.getPayload();

             let userResult = await pool.query('SELECT * FROM usersapp WHERE email = $1', [email]);
             let user;

             if (userResult.rows.length > 0) {
                 user = userResult.rows[0];
             } else {
                 const newUserQuery = `
                     INSERT INTO usersapp (email, username, profile_pic_url)
                     VALUES ($1, $2, $3)
                     RETURNING *;
                 `;
                 const newUsername = name.replace(/ /g, '').substring(0, 15) + Math.floor(Math.random() * 1000);
                 const newUserResult = await pool.query(newUserQuery, [email, newUsername, picture]);
                 user = newUserResult.rows[0];
             }
             
             const appToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });

             res.status(200).json({
                 success: true,
                 message: 'Inicio de sesión con Google exitoso.',
                 token: appToken
             });

         } catch (error) {
             console.error("Error en la verificación de Google:", error);
             res.status(401).json({ success: false, message: 'Token de Google inválido o expirado.' });
         }
     });

     return router;
 };
