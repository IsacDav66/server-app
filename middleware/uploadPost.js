// Archivo: /server/middleware/uploadPost.js

const multer = require('multer');
const path = require('path');

// Configuración de almacenamiento: guarda el archivo en el disco
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // La ruta donde se guardarán los archivos
        cb(null, path.join(__dirname, '../uploads/post_images/')); // Carpeta separada
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const userId = req.user.userId; 
        const timestamp = Date.now();
        
        // Nombra el archivo como: post_<userId>_<timestamp>.<ext>
        cb(null, `post_${userId}_${timestamp}${ext}`); 
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

// Inicializar Multer para una sola imagen de post
const uploadPost = multer({ 
    storage: storage,
    limits: { 
        fileSize: 10 * 1024 * 1024 // Limite de 10MB
    },
    fileFilter: fileFilter
});

// Exporta el middleware configurado. El campo 'postImage' debe coincidir con el frontend
module.exports = uploadPost.single('postImage');