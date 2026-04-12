"""Print a likely LAN URL for opening SAMSEL Web on a phone (Windows / same Wi-Fi)."""
import os
import socket


def main() -> None:
    port = (os.environ.get("SAMSEL_PORT") or os.environ.get("PORT") or "8765").strip() or "8765"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(0.35)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        finally:
            s.close()
        if ip and not ip.startswith("127."):
            print(f"Phone (same Wi-Fi): http://{ip}:{port}/")
            return
    except OSError:
        pass
    print(f"Phone: run ipconfig, find this PC's IPv4, open http://THAT_IP:{port}/")


if __name__ == "__main__":
    main()
