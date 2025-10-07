// Archivo: /server/middleware/auth.js

// Nota: Eliminamos el require('jsonwebtoken') ya que no se usa.
// Tampoco necesitamos inyectar el JWT_SECRET.

/**
 * Middleware para proteger rutas basado en la sesión activa.
 * 
 * Verifica si el req.session.userId existe, lo que indica que una sesión de usuario válida está activa.
 */
const protect = (req, res, next) => {
    
    // El objeto de sesión (req.session) es poblado automáticamente por el middleware 'express-session'
    // si se encuentra una cookie de sesión válida.
    
    // 1. Verificar si la sesión tiene un ID de usuario
    if (req.session && req.session.userId) {
        
        // 2. Adjuntamos el userId al objeto req para que el controlador lo use
        // NOTA: En este sistema, la cookie se envía AUTOMÁTICAMENTE por el WebView.
        req.user = { userId: req.session.userId }; 
        
        next(); // Sesión válida: Continúa a la ruta (ej. /api/user/me)
        
    } else {
        // 3. No hay sesión válida: Devuelve 401
        console.log('❌ Sesión de usuario no encontrada. Bloqueando acceso a ruta protegida.');
        res.status(401).json({ 
            success: false, 
            message: 'No autorizado. La sesión ha expirado o no ha iniciado sesión.' 
        });
    }
};

module.exports = { protect };