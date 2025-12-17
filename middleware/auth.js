// Archivo: /server/middleware/auth.js

const jwt = require('jsonwebtoken');

const protect = (req, res, next, JWT_SECRET) => {
    let token;
    
    // --- LOG 1: Ver las cabeceras que llegan ---
    console.log(`[AUTH LOG] Protegiendo ruta: ${req.originalUrl}`);
    console.log('[AUTH LOG] Cabeceras de autorización:', req.headers.authorization);

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
        // --- LOG 2: Ver el token que se extrajo ---
        console.log('[AUTH LOG] Token extraído:', token);
    }

    if (!token) {
        // --- LOG 3: Confirmar por qué se está rechazando ---
        console.log('[AUTH LOG] ¡RECHAZADO! Razón: No se encontró token en las cabeceras.');
        return res.status(401).json({ success: false, message: 'No autorizado. Token no encontrado.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = { userId: decoded.userId }; 
        
        // --- LOG 4: Confirmar que el token es válido ---
        console.log(`[AUTH LOG] ¡APROBADO! Token verificado para userId: ${decoded.userId}`);
        next();
    } catch (error) {
        // --- LOG 5: Confirmar si el token es inválido ---
        console.log('[AUTH LOG] ¡RECHAZADO! Razón: El token es inválido o ha expirado.', error.message);
        res.status(401).json({ success: false, message: 'No autorizado. Token inválido.' });
    }
};

/**
 * Middleware SUAVE (NUEVO): Intenta decodificar el usuario si hay un token,
 * pero NUNCA bloquea la ruta. Ideal para rutas públicas con contenido personalizado.
 */
const softProtect = (req, res, next, JWT_SECRET) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = { userId: decoded.userId }; // Adjunta el usuario si el token es válido
        } catch (error) {
            // Si el token es inválido o expirado, simplemente no hacemos nada.
            req.user = null;
        }
    }
    
    next(); // Siempre continúa a la siguiente función
};


// Exportar ambos middlewares
module.exports = { protect, softProtect };