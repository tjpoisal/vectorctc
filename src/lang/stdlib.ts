/** Python 3.13 `sys.stdlib_module_names` (top-level names), plus a few legacy ones still common in code. */
export const PYTHON_STDLIB = new Set(
  `__future__ _thread abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect builtins bz2
calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars
copy copyreg cProfile crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip
enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc getopt getpass gettext glob graphlib grp gzip
hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale
logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib ntpath numbers
opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint
profile pstats pty pwd py_compile pyclbr pydoc pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched
secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile
sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable sys sysconfig syslog tabnanny tarfile
telnetlib tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle
turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xdrlib xml
xmlrpc zipapp zipfile zipimport zlib zoneinfo _abc _ast _collections_abc _io _weakref`.split(/\s+/),
);

/** Distribution name → import name, for packages whose names differ. */
export const PYTHON_DIST_ALIASES: Record<string, string[]> = {
  pyyaml: ["yaml"],
  beautifulsoup4: ["bs4"],
  pillow: ["PIL"],
  "scikit-learn": ["sklearn"],
  "scikit-image": ["skimage"],
  "python-dateutil": ["dateutil"],
  "opencv-python": ["cv2"],
  "opencv-python-headless": ["cv2"],
  protobuf: ["google"],
  attrs: ["attr", "attrs"],
  pyjwt: ["jwt"],
  "python-dotenv": ["dotenv"],
  "psycopg2-binary": ["psycopg2"],
  "psycopg-binary": ["psycopg"],
  "typing-extensions": ["typing_extensions"],
  "google-cloud-storage": ["google"],
  "google-api-python-client": ["googleapiclient"],
  pymysql: ["pymysql"],
  "mysqlclient": ["MySQLdb"],
  "python-multipart": ["multipart"],
  "pyserial": ["serial"],
  "pyzmq": ["zmq"],
  "pycryptodome": ["Crypto"],
  "msgpack-python": ["msgpack"],
  "django-rest-framework": ["rest_framework"],
  djangorestframework: ["rest_framework"],
  "email-validator": ["email_validator"],
  "pydantic-settings": ["pydantic_settings"],
  setuptools: ["setuptools", "pkg_resources"],
  "ruamel.yaml": ["ruamel"],
};

/** Go standard library import paths (Go 1.23). */
export const GO_STDLIB = new Set(
  `archive/tar archive/zip bufio bytes cmp compress/bzip2 compress/flate compress/gzip compress/lzw compress/zlib container/heap
container/list container/ring context crypto crypto/aes crypto/cipher crypto/des crypto/dsa crypto/ecdh crypto/ecdsa crypto/ed25519
crypto/elliptic crypto/hmac crypto/md5 crypto/rand crypto/rc4 crypto/rsa crypto/sha1 crypto/sha256 crypto/sha512 crypto/subtle
crypto/tls crypto/x509 crypto/x509/pkix database/sql database/sql/driver debug/buildinfo debug/dwarf debug/elf debug/gosym
debug/macho debug/pe debug/plan9obj embed encoding encoding/ascii85 encoding/asn1 encoding/base32 encoding/base64 encoding/binary
encoding/csv encoding/gob encoding/hex encoding/json encoding/pem encoding/xml errors expvar flag fmt go/ast go/build
go/build/constraint go/constant go/doc go/doc/comment go/format go/importer go/parser go/printer go/scanner go/token go/types
go/version hash hash/adler32 hash/crc32 hash/crc64 hash/fnv hash/maphash html html/template image image/color image/color/palette
image/draw image/gif image/jpeg image/png index/suffixarray io io/fs io/ioutil iter log log/slog log/syslog maps math math/big
math/bits math/cmplx math/rand math/rand/v2 mime mime/multipart mime/quotedprintable net net/http net/http/cgi net/http/cookiejar
net/http/fcgi net/http/httptest net/http/httptrace net/http/httputil net/http/pprof net/mail net/netip net/rpc net/rpc/jsonrpc
net/smtp net/textproto net/url os os/exec os/signal os/user path path/filepath plugin reflect regexp regexp/syntax runtime
runtime/cgo runtime/coverage runtime/debug runtime/metrics runtime/pprof runtime/race runtime/trace slices sort strconv strings
structs sync sync/atomic syscall syscall/js testing testing/fstest testing/iotest testing/quick testing/slogtest text/scanner
text/tabwriter text/template text/template/parse time time/tzdata unicode unicode/utf16 unicode/utf8 unique unsafe weak C`.split(/\s+/),
);
