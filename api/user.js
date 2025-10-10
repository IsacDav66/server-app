// Archivo: /server/api/user.js

const express = require('express');
const { protect } = require('../middleware/auth'); 
const uploadMiddleware = require('../middleware/upload'); // <-- AÑADIDO
const path = require('path'); // <-- AÑADIDO


module.exports = (pool, JWT_SECRET) => { // <-- AHORA RECIBE JWT_SECRET
    const router = express.Router();

    // ----------------------------------------------------
    // RUTA PROTEGIDA: Manejo explícito del OPTIONS de CORS
    // Se deja, ya que es buena práctica
    // ----------------------------------------------------
    router.options('/me', (req, res) => {
        res.sendStatus(200); 
    });

    // ----------------------------------------------------
    // RUTA PROTEGIDA: Obtener datos del usuario (y checkear perfil)
    // ----------------------------------------------------
    router.get('/me', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => { 
        
        try {
            // Buscamos todos los campos de perfil
            const query = 'SELECT email, username, age, gender, profile_pic_url FROM usersapp WHERE id = $1';
            const result = await pool.query(query, [req.user.userId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Usuario no encontrado en DB.' });
            }
            
            const user = result.rows[0];
            
            // Checkear si el perfil está completo
            const isProfileComplete = !!user.username && user.age !== null && user.gender !== null;
            
            res.status(200).json({
                success: true,
                message: 'Acceso a la ruta protegida concedido.',
                data: {
                    userId: req.user.userId,
                    email: user.email,
                    username: user.username,
                    isProfileComplete: isProfileComplete, // <-- CLAVE: Estado del perfil
                    age: user.age,
                    gender: user.gender,
                    profilePicUrl: user.profile_pic_url
                }
            });
        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error al obtener datos del usuario.' });
        }
    });

    // ----------------------------------------------------
    // NUEVA RUTA: Actualizar Perfil (/api/user/complete-profile)
    // ----------------------------------------------------
    router.post('/complete-profile', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => {
        const { username, age, gender } = req.body;
        const userId = req.user.userId;

        if (!username || !age || !gender) {
            return res.status(400).json({ success: false, message: 'Faltan campos obligatorios: username, edad, o género.' });
        }

        try {
            const query = `
                UPDATE usersapp 
                SET username = $1, age = $2, gender = $3 
                WHERE id = $4 AND (username IS NULL OR username = $1)
                RETURNING id;
            `;
            const result = await pool.query(query, [username, age, gender, userId]);

            if (result.rowCount === 0) {
                 // Si falla, puede ser por username duplicado (aunque el where lo evita, el UNIQUE constraint saltaría)
                 // O el usuario no existe.
                 return res.status(409).json({ success: false, message: 'El nombre de usuario ya está en uso.' });
            }

            res.status(200).json({ 
                success: true, 
                message: 'Perfil completado con éxito.' 
            });

        } catch (error) {
            if (error.code === '23505') { // Error de violación de unicidad
                return res.status(409).json({ success: false, message: 'El nombre de usuario ya está en uso.' });
            }
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error al actualizar el perfil.' });
        }
    });

    return router;
};