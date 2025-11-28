const CACHE_NAME = 'novacast-v1.4.2';
const urlsToCache = [
    './',
    './index.html',
    './styles.css',
    './script.js',
    './IMG_5959.webp',
    './Colorway=2-Color White@3x.png',
    './Colorway=1-Color Black@3x.png'
];

self.addEventListener('install', event => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Caching app shell');
                return cache.addAll(urlsToCache);
            })
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;


    if (request.url.includes('/api/')) {
        event.respondWith(
            fetch(request)
                .catch(() => caches.match(request))
        );
        return;
    }


    event.respondWith(
        caches.match(request)
            .then(response => {
                if (response) {
                    return response;
                }


                return fetch(request).then(response => {

                    if (!response || response.status !== 200) {
                        return response;
                    }


                    const responseToCache = response.clone();

                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(request, responseToCache);
                    });

                    return response;
                });
            })
    );
});


self.addEventListener('push', event => {
    const options = {
        body: event.data ? event.data.text() : 'New weather update available',
        icon: 'IMG_5959.webp',
        badge: 'IMG_5959.webp',
        vibrate: [200, 100, 200]
    };

    event.waitUntil(
        self.registration.showNotification('NovaCast Weather Alert', options)
    );
});


