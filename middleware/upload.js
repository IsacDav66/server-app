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
        const ext = path.extname(file.originalname);
        const userId = req.user.userId; 
        const timestamp = Date.now(); // <-- CLAVE: Obtener el timestamp actual
        
        // Nombra el archivo como: profile_<userId>_<timestamp>.<ext>
        // Ejemplo: profile_3_1730910000000.jpg
        cb(null, `profile_${userId}_${timestamp}${ext}`); // <-- NUEVO FORMATO
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