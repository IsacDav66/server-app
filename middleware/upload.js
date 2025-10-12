// Archivo: /server/middleware/upload.js

const multer = require('multer');
const path = require('path');
const fs = require('fs'); // <-- AÑADIDO: Módulo File System de Node.js


// --- NUEVA LÓGICA DE DESTINO ---
// 1. Definir la ruta de destino
const profileImagesPath = path.join(__dirname, '../uploads/profile_images/');

// 2. Asegurarse de que el directorio exista
fs.mkdirSync(profileImagesPath, { recursive: true });
// -----------------------------


// Configuración de almacenamiento: guarda el archivo en el disco
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // La ruta donde se guardarán los archivos de perfil
        cb(null, profileImagesPath); // <-- CAMBIADO
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const userId = req.user.userId; 
        const timestamp = Date.now();
        
        // El nombre del archivo sigue siendo el mismo formato, solo cambia su ubicación
        cb(null, `profile_${userId}_${timestamp}${ext}`);
    }
});

// Filtro de archivos (sin cambios)
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos de imagen.'), false);
    }
};

// Inicializar Multer (sin cambios)
const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 5 * 1024 * 1024 // Limite de 5MB
    },
    fileFilter: fileFilter
});

// Exporta el middleware configurado (sin cambios)
module.exports = upload.single('profilePic');