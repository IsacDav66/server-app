// Archivo: /server/api/user.js

const express = require('express');
const { protect } = require('../middleware/auth'); 

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
    // RUTA PROTEGIDA: Obtener datos del usuario (requiere token)
    // ----------------------------------------------------
    // Se usa una función anónima para inyectar JWT_SECRET a 'protect'
    router.get('/me', (req, res, next) => protect(req, res, next, JWT_SECRET), async (req, res) => { 
        
        // Si llegamos aquí, el middleware 'protect' verificó el token y cargó req.user.userId
        
        try {
            // Buscamos el email para la respuesta usando el ID que el token nos dio
            const query = 'SELECT email FROM usersapp WHERE id = $1';
            const result = await pool.query(query, [req.user.userId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Usuario no encontrado en DB.' });
            }

            res.status(200).json({
                success: true,
                message: 'Acceso a la ruta protegida concedido.',
                data: {
                    userId: req.user.userId,
                    email: result.rows[0].email,
                }
            });
        } catch (error) {
            console.error(error.stack);
            res.status(500).json({ success: false, message: 'Error al obtener datos del usuario.' });
        }
    });

    return router;
};