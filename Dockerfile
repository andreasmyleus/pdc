FROM nginx:1.27-alpine

# Copy site files to nginx html dir
COPY . /usr/share/nginx/html

# Provide a default nginx config optimized for static hosting
RUN rm /etc/nginx/conf.d/default.conf || true
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Port 8080 is unprivileged. Run as uid 10001 after install.
# nginx must create its cache/temp dirs and write a pid file;
# /run is not writable by this user, so the pid goes to /tmp.
RUN addgroup -g 10001 -S app \
    && adduser -S -D -H -u 10001 -G app app \
    && sed -i 's|^user  nginx;|#user  nginx;|' /etc/nginx/nginx.conf \
    && sed -i 's|pid        /run/nginx.pid;|pid        /tmp/nginx.pid;|' /etc/nginx/nginx.conf \
    && chown -R app:app /var/cache/nginx

EXPOSE 8080

USER app

CMD ["nginx", "-g", "daemon off;"]


