// Archivo: /server/middleware/upload.js

const multer = require('multer');
const path = require('path');

// Configuración de almacenamiento: guarda el archivo en el disco
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // La ruta donde se guardarán los archivos
        cb(null, path.join(__dirname, '../uploads/')); 
    },
    filename: (req, file, cb) => {
        // Nombra el archivo usando el ID del usuario y la fecha, con su extensión original
        const ext = path.extname(file.originalname);
        // Usamos el ID de usuario para asegurar que cada usuario solo tiene una foto de perfil
        const userId = req.user.userId; 
        cb(null, `profile_${userId}${ext}`); 
    }
});

// Filtro de archivos: solo permite imágenes
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos de imagen.'), false);
    }
};

// Inicializar Multer
const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 5 * 1024 * 1024 // Limite de 5MB
    },
    fileFilter: fileFilter
});

// Exporta el middleware configurado
// El campo 'profilePic' debe coincidir con el 'name' del input file del frontend
module.exports = upload.single('profilePic');