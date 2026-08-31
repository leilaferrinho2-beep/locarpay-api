importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyDTd-f-QTKNhixlYCDVHI5pGe9H8hxwON4',
  authDomain:        'locarpayapp.firebaseapp.com',
  projectId:         'locarpayapp',
  storageBucket:     'locarpayapp.appspot.com',
  messagingSenderId: '531468711275'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const title = payload.data?.title || payload.notification?.title || 'iLocarPay';
  const body  = payload.data?.body  || payload.notification?.body  || 'Nova notificação';
  self.registration.showNotification(title, {
    body,
    icon:  '/logo.png',
    badge: '/logo.png',
    tag:   payload.data?.type || 'ilp',
    renotify: true,
    data: payload.data || {}
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('https://www.ilocarpay.com.br/admin'));
});
