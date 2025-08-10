FROM nginx:1.27-alpine

# Copy site files to nginx html dir
COPY . /usr/share/nginx/html

# Provide a default nginx config optimized for static hosting
RUN rm /etc/nginx/conf.d/default.conf || true
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]


