#pragma once
#include <algorithm>
#include <cstddef>
#include <cstring>
#include <initializer_list>
#include <new>
#include <type_traits>
#include <utility>

// SmallVector<T, N> — stack-allocated vector with heap overflow.
// Provides the std::vector API subset used by the agent codebase:
// push_back, emplace_back, begin/end (raw T* iterators), insert,
// resize, size/empty/clear, operator[], copy/move semantics.
// Falls back to heap only when size exceeds N.
template<typename T, size_t N>
class SmallVector {
    alignas(T) unsigned char buf_[sizeof(T) * N];
    T* data_;
    size_t size_  = 0;
    size_t cap_   = N;

    T*       inlineData()       { return reinterpret_cast<T*>(buf_); }
    const T* inlineData() const { return reinterpret_cast<const T*>(buf_); }

    void grow(size_t minCap) {
        size_t newCap = cap_ * 2;
        if (newCap < minCap) newCap = minCap;
        T* nd = static_cast<T*>(::operator new(newCap * sizeof(T), std::align_val_t(alignof(T))));
        for (size_t i = 0; i < size_; ++i) {
            new (nd + i) T(std::move(data_[i]));
            data_[i].~T();
        }
        if (data_ != inlineData())
            ::operator delete(data_, std::align_val_t(alignof(T)));
        data_ = nd;
        cap_  = newCap;
    }

public:
    SmallVector() : data_(inlineData()) {}

    ~SmallVector() {
        for (size_t i = 0; i < size_; ++i) data_[i].~T();
        if (data_ != inlineData())
            ::operator delete(data_, std::align_val_t(alignof(T)));
    }

    // ── Copy ──
    SmallVector(const SmallVector& o) : data_(inlineData()) {
        reserve(o.size_);
        for (size_t i = 0; i < o.size_; ++i)
            new (data_ + i) T(o.data_[i]);
        size_ = o.size_;
    }
    SmallVector& operator=(const SmallVector& o) {
        if (this == &o) return *this;
        clear();
        reserve(o.size_);
        for (size_t i = 0; i < o.size_; ++i)
            new (data_ + i) T(o.data_[i]);
        size_ = o.size_;
        return *this;
    }

    // ── Move ──
    SmallVector(SmallVector&& o) noexcept : data_(inlineData()) {
        if (o.data_ == o.inlineData()) {
            for (size_t i = 0; i < o.size_; ++i)
                new (data_ + i) T(std::move(o.data_[i]));
            size_ = o.size_;
        } else {
            data_ = o.data_;  size_ = o.size_;  cap_ = o.cap_;
            o.data_ = o.inlineData();  o.size_ = 0;  o.cap_ = N;
        }
    }
    SmallVector& operator=(SmallVector&& o) noexcept {
        if (this == &o) return *this;
        for (size_t i = 0; i < size_; ++i) data_[i].~T();
        if (data_ != inlineData())
            ::operator delete(data_, std::align_val_t(alignof(T)));
        data_ = inlineData();  size_ = 0;  cap_ = N;
        if (o.data_ == o.inlineData()) {
            for (size_t i = 0; i < o.size_; ++i)
                new (data_ + i) T(std::move(o.data_[i]));
            size_ = o.size_;
        } else {
            data_ = o.data_;  size_ = o.size_;  cap_ = o.cap_;
            o.data_ = o.inlineData();  o.size_ = 0;  o.cap_ = N;
        }
        return *this;
    }

    // ── Initializer list ──
    SmallVector(std::initializer_list<T> il) : data_(inlineData()) {
        reserve(il.size());
        for (auto& e : il) { new (data_ + size_) T(e); ++size_; }
    }
    SmallVector& operator=(std::initializer_list<T> il) {
        clear();
        reserve(il.size());
        for (auto& e : il) { new (data_ + size_) T(e); ++size_; }
        return *this;
    }

    // ── Iterators (raw pointers — satisfy RandomAccessIterator) ──
    T*       begin()       { return data_; }
    T*       end()         { return data_ + size_; }
    const T* begin() const { return data_; }
    const T* end()   const { return data_ + size_; }

    // ── Capacity ──
    size_t size()     const { return size_; }
    bool   empty()    const { return size_ == 0; }
    size_t capacity() const { return cap_; }

    void reserve(size_t n) {
        if (n > cap_) grow(n);
    }

    // ── Element access ──
    T&       operator[](size_t i)       { return data_[i]; }
    const T& operator[](size_t i) const { return data_[i]; }
    T&       front()       { return data_[0]; }
    const T& front() const { return data_[0]; }
    T&       back()        { return data_[size_ - 1]; }
    const T& back()  const { return data_[size_ - 1]; }
    T*       data()        { return data_; }
    const T* data()  const { return data_; }

    // ── Modifiers ──
    void push_back(const T& v) {
        if (size_ >= cap_) grow(size_ + 1);
        new (data_ + size_) T(v);
        ++size_;
    }
    void push_back(T&& v) {
        if (size_ >= cap_) grow(size_ + 1);
        new (data_ + size_) T(std::move(v));
        ++size_;
    }
    template<typename... Args>
    T& emplace_back(Args&&... args) {
        if (size_ >= cap_) grow(size_ + 1);
        new (data_ + size_) T(std::forward<Args>(args)...);
        return data_[size_++];
    }
    void pop_back() {
        --size_;
        data_[size_].~T();
    }
    void clear() {
        for (size_t i = 0; i < size_; ++i) data_[i].~T();
        size_ = 0;
    }
    void resize(size_t n) {
        if (n < size_) {
            for (size_t i = n; i < size_; ++i) data_[i].~T();
        } else if (n > size_) {
            reserve(n);
            for (size_t i = size_; i < n; ++i) new (data_ + i) T();
        }
        size_ = n;
    }

    // ── Erase single element at iterator position ──
    T* erase(T* pos) {
        pos->~T();
        for (T* p = pos; p != data_ + size_ - 1; ++p) {
            new (p) T(std::move(*(p + 1)));
            (p + 1)->~T();
        }
        --size_;
        return pos;
    }

    // ── Insert single element at iterator position ──
    T* insert(T* pos, const T& val) {
        size_t off = static_cast<size_t>(pos - data_);
        if (size_ >= cap_) grow(size_ + 1);
        for (size_t i = size_; i > off; ) {
            --i;
            new (data_ + i + 1) T(std::move(data_[i]));
            data_[i].~T();
        }
        new (data_ + off) T(val);
        ++size_;
        return data_ + off;
    }

    // ── Insert range at iterator position ──
    template<typename InputIt>
    T* insert(T* pos, InputIt first, InputIt last) {
        size_t off   = static_cast<size_t>(pos - data_);
        size_t count = static_cast<size_t>(std::distance(first, last));
        if (count == 0) return data_ + off;
        reserve(size_ + count);
        for (size_t i = size_; i > off; ) {
            --i;
            new (data_ + i + count) T(std::move(data_[i]));
            data_[i].~T();
        }
        for (size_t i = 0; i < count; ++i)
            new (data_ + off + i) T(*(first + i));
        size_ += count;
        return data_ + off;
    }
};
