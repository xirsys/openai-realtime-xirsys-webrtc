# Hosting multiple tutorials on one DigitalOcean Droplet

This repository can run as an isolated Node.js service behind Caddy. The same
Droplet can host more tutorials by assigning each application a private
localhost port and a separate HTTPS hostname.

## Shared host layout

```text
/srv/tutorials/<tutorial-name>       application checkout
/etc/xirsys-tutorials/<name>.env     root-readable environment file
/etc/systemd/system/<name>.service   application process and recovery policy
/etc/caddy/Caddyfile                 public HTTPS host routing
```

Only Caddy listens on public ports 80 and 443. Each Node.js application listens
on `127.0.0.1` through a different port. SSH is key-only and application
processes run as the unprivileged `deploy` user.

## Add another tutorial

1. Clone the repository into `/srv/tutorials/<tutorial-name>` as `deploy`.
2. Install and build its production dependencies.
3. Put only that application's secrets in
   `/etc/xirsys-tutorials/<tutorial-name>.env` with mode `0640`, owned by
   `root:deploy`.
4. Add a systemd unit that binds the application to an unused localhost port.
5. Add a Caddy site block for the tutorial's DNS name:

   ```caddyfile
   tutorial.example.com {
     reverse_proxy 127.0.0.1:3002
   }
   ```

6. Run `sudo caddy validate --config /etc/caddy/Caddyfile`, reload Caddy, and
   verify both the application's local health endpoint and its public HTTPS URL.

Do not copy a workstation `.env` file to the server wholesale. Select only the
credentials required by the application so unrelated cloud credentials never
reach the Droplet.
