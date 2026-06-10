"""Setup script for the ScrapeSuite Python SDK."""

from setuptools import setup, find_packages

setup(
    name="scrapesuite",
    version="1.0.0",
    description="Official Python SDK for the ScrapeSuite web scraping API",
    long_description=open("README.md").read() if __import__("os").path.exists("README.md") else "",
    long_description_content_type="text/markdown",
    author="ScrapeSuite",
    author_email="sdk@scrapesuite.dev",
    url="https://github.com/scrapesuite/scrapesuite-python",
    packages=find_packages(exclude=["tests", "tests.*"]),
    python_requires=">=3.9",
    install_requires=[
        "httpx>=0.24.0",
        "pydantic>=2.0.0",
    ],
    extras_require={
        "browser": ["playwright>=1.30.0"],
        "dev": ["pytest>=7.0", "pytest-asyncio>=0.21", "respx>=0.20"],
    },
    classifiers=[
        "Development Status :: 5 - Production/Stable",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Internet :: WWW/HTTP",
        "Topic :: Software Development :: Libraries :: Python Modules",
    ],
)
